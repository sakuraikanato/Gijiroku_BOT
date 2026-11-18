import { VoiceConnectionStatus } from "@discordjs/voice";
import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  MessageFlags,
  type ApplicationCommandManager,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { VoiceSessions } from "./voice";

const commands = [
  { name: "start", description: "あなたが参加しているボイスチャンネルに Bot を接続します" },
  { name: "stop", description: "このサーバーのボイスチャンネルから Bot を退出させます" },
  { name: "status", description: "このサーバーの Bot の VC 接続状態を表示します" },
] as const;

export async function registerCommands(
  manager: Pick<ApplicationCommandManager, "create">,
  guildIds: readonly string[],
  signal: AbortSignal,
) {
  const scopes = guildIds.length ? guildIds : [undefined];
  for (const guildId of scopes) {
    for (const command of commands) {
      signal.throwIfAborted();
      const definition = guildId ? command : {
        ...command,
        contexts: [InteractionContextType.Guild],
        integrationTypes: [ApplicationIntegrationType.GuildInstall],
      };
      await manager.create(definition, guildId);
    }
  }
}

export function isVoiceCommand(name: string) {
  return commands.some((command) => command.name === name);
}

type VoiceInteraction = Pick<ChatInputCommandInteraction<"cached">,
  "commandName" | "guild" | "guildId" | "user" | "reply" | "deferReply" | "editReply"
>;

const ephemeral = { flags: MessageFlags.Ephemeral } as const;
const joinMessage = {
  joined: "VC に接続しました。",
  "already-active": "このサーバーでは VC に接続済みか、接続処理中です。",
  cancelled: "VC 接続を中止しました。",
  failed: "VC に接続できませんでした。チャンネルの権限と空き状況を確認して再試行してください。",
};

export async function handleVoiceCommand(
  interaction: VoiceInteraction,
  voice: Pick<VoiceSessions, "start" | "stop" | "status">,
) {
  const { guildId } = interaction;

  switch (interaction.commandName) {
    case "start": {
      if (voice.status(guildId)) {
        await interaction.reply({ ...ephemeral, content: joinMessage["already-active"] });
        return;
      }
      const channel = interaction.guild.voiceStates.cache.get(interaction.user.id)?.channel;
      if (channel?.type !== ChannelType.GuildVoice) {
        await interaction.reply({ ...ephemeral, content: "通常の VC に参加してから /start を実行してください。" });
        return;
      }
      if (!channel.joinable) {
        await interaction.reply({ ...ephemeral, content: "Bot を VC に接続できません。閲覧・接続権限と空き状況を確認してください。" });
        return;
      }

      await interaction.deferReply(ephemeral);
      const result = await voice.start({
        channelId: channel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });
      await interaction.editReply(joinMessage[result]);
      return;
    }
    case "stop": {
      const content = voice.stop(guildId) ? "VC から退出しました。" : "接続中の VC はありません。";
      await interaction.reply({ ...ephemeral, content });
      return;
    }
    case "status": {
      const status = voice.status(guildId);
      const channel = status?.channelId ? ` <#${status.channelId}>` : "";
      const content = status
        ? `${status.state === VoiceConnectionStatus.Ready ? "接続中" : "接続処理中"}${channel}`
        : "接続中の VC はありません。";
      await interaction.reply({ ...ephemeral, content });
    }
  }
}
