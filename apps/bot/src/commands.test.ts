import { expect, mock, test } from "bun:test";
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { SqliteRepository } from "@gijiroku/shared/database";
import { handleVoiceCommand } from "./commands";
import { loadOptions } from "@gijiroku/shared/options";
import { fileURLToPath } from "node:url";

test("/setup persists the invoking channel with Guild isolation and enforces permissions", async () => {
  const repository = new SqliteRepository(":memory:");
  const options = loadOptions(fileURLToPath(new URL("../../../options/", import.meta.url)));
  const voice = { start: mock(async () => "joined" as const), stop: () => false, status: () => undefined };
  const reply = mock(async (_response: unknown) => {});
  const interaction = {
    commandName: "setup",
    guildId: "123456789012345678",
    channelId: "234567890123456789",
    channel: {
      type: ChannelType.GuildText,
      permissionsFor: () => new PermissionsBitField([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
      ]),
    },
    memberPermissions: new PermissionsBitField(),
    guild: { members: { me: { id: "345678901234567890" } } },
    reply,
    user: { id: "456789012345678901" },
    deferReply: mock(async () => {}),
    editReply: mock(async () => {}),
  };
  // The boundary is Discord's interaction object. The test supplies its used properties.
  const invoke = () => handleVoiceCommand(
    interaction as unknown as Parameters<typeof handleVoiceCommand>[0], voice, { repository, options },
  );
  try {
    await invoke();
    expect(repository.getOutputChannel(interaction.guildId)).toBeNull();
    expect(reply.mock.calls.at(-1)?.[0]).toMatchObject({ content: expect.stringContaining("サーバー管理") });
    interaction.memberPermissions.add(PermissionFlagsBits.ManageGuild);
    await invoke();
    expect(repository.getOutputChannel(interaction.guildId)).toBe(interaction.channelId);
    expect(repository.getOutputChannel("987654321098765432")).toBeNull();

    interaction.channelId = "567890123456789012";
    await invoke();
    expect(repository.getOutputChannel(interaction.guildId)).toBe(interaction.channelId);
    interaction.channel.permissionsFor = () => new PermissionsBitField();
    interaction.channelId = "678901234567890123";
    await invoke();
    expect(repository.getOutputChannel(interaction.guildId)).toBe("567890123456789012");

    interaction.commandName = "start";
    interaction.guildId = "987654321098765432";
    await invoke();
    expect(voice.start).not.toHaveBeenCalled();
    expect(reply.mock.calls.at(-1)?.[0]).toMatchObject({ content: expect.stringContaining("/setup") });
  } finally {
    repository.close();
  }
});
