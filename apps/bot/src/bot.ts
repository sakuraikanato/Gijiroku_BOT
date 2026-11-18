import { once } from "node:events";
import type { DiscordOptions } from "@gijiroku/shared/options";
import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { handleVoiceCommand, isVoiceCommand, registerCommands } from "./commands";
import { VoiceSessions } from "./voice";

export function readBotToken(options: DiscordOptions, environment: NodeJS.ProcessEnv): string {
  const token = environment[options.tokenEnv]?.trim()
    || (options.tokenEnv === "DISCORD_BOT_TOKEN" ? environment.TOKEN?.trim() : undefined);
  if (!token) {
    throw new Error(`options/discord.json の tokenEnv で指定した環境変数 ${options.tokenEnv} が未設定です。`);
  }
  return token;
}

export function createBotClient() {
  return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
}

export async function connectGateway(client: Client, token: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const waiting = new AbortController();
  const ready = once(client, Events.ClientReady, {
    signal: AbortSignal.any([signal, waiting.signal, AbortSignal.timeout(30_000)]),
  });
  try {
    await Promise.all([ready, client.login(token)]);
  } finally {
    waiting.abort();
  }
  if (!client.isReady()) throw new Error("Discord Gateway is unavailable.");
  return client;
}

export function createBot(options: DiscordOptions, client = createBotClient(), voice = new VoiceSessions()) {
  const abort = new AbortController();
  let commandsReady = false;
  let closing: Promise<void> | undefined;

  client.on(Events.Error, () => console.error("Discord クライアントでエラーが発生しました。"));
  client.on(Events.ShardError, () => console.error("Discord Gateway で通信エラーが発生しました。"));
  client.on(Events.GuildDelete, (guild) => voice.stop(guild.id));
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.inCachedGuild() ||
      !isVoiceCommand(interaction.commandName) || abort.signal.aborted) return;
    if (options.commandGuildIds.length && !options.commandGuildIds.includes(interaction.guildId)) return;

    if (!commandsReady) {
      void interaction.reply({ flags: MessageFlags.Ephemeral, content: "Bot の起動処理中です。" })
        .catch(() => console.error("Discord にコマンド応答を送信できませんでした。"));
      return;
    }

    void handleVoiceCommand(interaction, voice).catch(async () => {
      console.error("Discord コマンドの処理中にエラーが発生しました。");
      const content = "コマンドを処理できませんでした。";
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(content);
        } else {
          await interaction.reply({ flags: MessageFlags.Ephemeral, content });
        }
      } catch {
        console.error("Discord にコマンド応答を送信できませんでした。");
      }
    });
  });

  return {
    async start(token: string) {
      let readyClient;
      try {
        readyClient = await connectGateway(client, token, abort.signal);
      } catch {
        throw new Error("Discord Gateway に接続できませんでした。トークンとネットワークを確認してください。");
      }

      try {
        await registerCommands(readyClient.application.commands, options.commandGuildIds, abort.signal);
      } catch {
        throw new Error("Slash Command を登録できませんでした。アプリのインストールと Guild ID を確認してください。");
      }
      abort.signal.throwIfAborted();
      commandsReady = true;
    },
    shutdown() {
      closing ??= (async () => {
        abort.abort();
        try {
          voice.close();
        } finally {
          await client.destroy();
        }
      })();
      return closing;
    },
  };
}
