import { expect, mock, spyOn, test } from "bun:test";
import {
  ChannelType,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  type ApplicationCommand,
  type ApplicationCommandDataResolvable,
  type ChatInputCommandInteraction,
  type Client,
  type ClientApplication,
} from "discord.js";
import { createBot, createBotClient, readBotToken } from "./bot";
import { registerCommands } from "./commands";
import { VoiceSessions } from "./voice";

const tokenEnv = "DISCORD_BOT_TOKEN";
const guildA = "123456789012345678";
const guildB = "234567890123456789";
const channelId = "345678901234567890";

function commandName(command: ApplicationCommandDataResolvable) {
  return "name" in command ? command.name : command.toJSON().name;
}

test("loads the configured token, supports the original local env name, and rejects a missing value", () => {
  const options = { tokenEnv, commandGuildIds: [] };
  expect(readBotToken(options, { DISCORD_BOT_TOKEN: " primary ", TOKEN: "legacy" })).toBe("primary");
  expect(readBotToken(options, { TOKEN: "legacy" })).toBe("legacy");
  expect(() => readBotToken(options, {})).toThrow("DISCORD_BOT_TOKEN");
  expect(() => readBotToken({ ...options, tokenEnv: "CUSTOM_TOKEN" }, { TOKEN: "legacy" })).toThrow("CUSTOM_TOKEN");
});

test("registers all commands per configured Guild and limits global commands to Guild contexts", async () => {
  const create = mock(async (_command: ApplicationCommandDataResolvable, _guild?: string) =>
    ({}) as ApplicationCommand);
  const signal = new AbortController().signal;

  await registerCommands({ create }, [guildA, guildB], signal);
  expect(create.mock.calls.map(([command, guild]) => [commandName(command), guild])).toEqual([
    ["setup", guildA], ["start", guildA], ["stop", guildA], ["status", guildA], ["config", guildA],
    ["setup", guildB], ["start", guildB], ["stop", guildB], ["status", guildB], ["config", guildB],
  ]);
  expect(create.mock.calls.every(([command]) => !("contexts" in command))).toBe(true);

  create.mockClear();
  await registerCommands({ create }, [], signal);
  expect(create.mock.calls.map(([command, guild]) => [commandName(command), guild])).toEqual([
    ["setup", undefined], ["start", undefined], ["stop", undefined], ["status", undefined], ["config", undefined],
  ]);
  expect(create.mock.calls[0]?.[0]).toMatchObject({ contexts: [InteractionContextType.Guild] });
});

test("Bot waits for Gateway readiness, handles commands in their Guild, and releases voice before Gateway", async () => {
  const client = createBotClient();
  expect(client.options.intents.has(GatewayIntentBits.GuildVoiceStates)).toBe(true);
  const order: string[] = [];
  const voice = new VoiceSessions(async (connection) => connection);
  const bot = createBot({ tokenEnv, commandGuildIds: [guildA, guildB] }, client, voice);
  const create = mock(async (command: ApplicationCommandDataResolvable, guild?: string) => {
    order.push(`register:${guild}:${commandName(command)}`);
    return {} as ApplicationCommand;
  });
  client.application = { commands: { create } } as unknown as ClientApplication;
  const login = spyOn(client, "login").mockResolvedValue("login-result");
  spyOn(client, "isReady").mockReturnValue(true);
  const destroy = spyOn(client, "destroy").mockImplementation(async () => {
    order.push("gateway:destroy");
  });

  async function invoke(commandName: string, guildId: string, voiceChannel = true) {
    const done = Promise.withResolvers<string>();
    const user = { id: "456789012345678901" };
    const channel = { id: channelId, type: ChannelType.GuildVoice, joinable: true };
    const interaction = {
      commandName,
      guildId,
      user,
      isChatInputCommand: () => true,
      isButton: () => false,
      inCachedGuild: () => true,
      guild: {
        voiceStates: { cache: new Map(voiceChannel ? [[user.id, { channel }]] : []) },
        voiceAdapterCreator: () => ({
          sendPayload: ({ d }: { d: { channel_id: string | null } }) => {
            order.push(d.channel_id ? `voice:join:${guildId}` : `voice:leave:${guildId}`);
            return true;
          },
          destroy: () => order.push(`adapter:destroy:${guildId}`),
        }),
      },
      reply: async (options: { flags: number; content: string }) => {
        expect(options.flags).toBe(MessageFlags.Ephemeral);
        done.resolve(options.content);
      },
      deferReply: async (options: { flags: number }) => {
        expect(options.flags).toBe(MessageFlags.Ephemeral);
      },
      editReply: async (content: string) => done.resolve(content),
    };
    client.emit(Events.InteractionCreate, interaction as unknown as ChatInputCommandInteraction<"cached">);
    return done.promise;
  }

  try {
    const starting = bot.start("configured-test-token");
    await Promise.resolve();
    expect(login).toHaveBeenCalledWith("configured-test-token");
    expect(create).not.toHaveBeenCalled();
    client.emit(Events.ClientReady, client as Client<true>);
    await starting;
    expect(create).toHaveBeenCalledTimes(10);

    expect(await invoke("status", guildA)).toBe("接続中の VC はありません。");
    expect(await invoke("start", guildA, false)).toContain("通常の VC");
    expect(await invoke("start", guildA)).toBe("VC に接続しました。");
    expect(await invoke("start", guildA)).toContain("接続済み");
    expect(await invoke("status", guildA)).toContain(`<#${channelId}>`);
    expect(await invoke("status", guildB)).toBe("接続中の VC はありません。");
    expect(await invoke("start", guildB)).toBe("VC に接続しました。");
    expect(await invoke("stop", guildA)).toBe("終了処理を行い、VC から退出しました。");
    expect(await invoke("status", guildB)).toContain(`<#${channelId}>`);
  } finally {
    await bot.shutdown();
  }

  await bot.shutdown();
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(order.slice(-5)).toEqual([
    `voice:leave:${guildA}`,
    `adapter:destroy:${guildA}`,
    `voice:leave:${guildB}`,
    `adapter:destroy:${guildB}`,
    "gateway:destroy",
  ]);
});
