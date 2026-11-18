import { VoiceConnectionStatus } from "@discordjs/voice";
import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  type ApplicationCommandManager,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { VoiceSessions } from "./voice";
import type { Repository } from "@gijiroku/shared/contracts";
import type { AppOptions } from "@gijiroku/shared/options";

const commands = [
  { name: "setup", description: "このテキストチャンネルを要約の投稿先に登録します", defaultMemberPermissions: PermissionFlagsBits.ManageGuild },
  { name: "start", description: "あなたが参加しているボイスチャンネルに Bot を接続します" },
  { name: "stop", description: "このサーバーのボイスチャンネルから Bot を退出させます" },
  { name: "status", description: "このサーバーの Bot の VC 接続状態を表示します" },
  { name: "config", description: "このサーバーの要約設定を表示します" },
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
  "commandName" | "guild" | "guildId" | "user" | "reply" | "deferReply" | "editReply" |
  "channel" | "channelId" | "memberPermissions"
>;
export type VoiceController = {
  start: VoiceSessions["start"];
  stop(guildId: string): boolean | Promise<boolean>;
  status(guildId: string): { channelId: string | null | undefined; state: string } | undefined;
  close(): void | Promise<void>;
};
export type CommandContext = {
  repository: Repository;
  options: AppOptions;
  audioStats?: () => { queued: number; paused: boolean };
};

const ephemeral = { flags: MessageFlags.Ephemeral } as const;
const joinMessage = {
  joined: "VC に接続しました。",
  "already-active": "このサーバーでは VC に接続済みか、接続処理中です。",
  cancelled: "VC 接続を中止しました。",
  failed: "VC に接続できませんでした。チャンネルの権限と空き状況を確認して再試行してください。",
};

export async function handleVoiceCommand(
  interaction: VoiceInteraction,
  voice: Pick<VoiceController, "start" | "stop" | "status">,
  context?: CommandContext,
) {
  const { guildId } = interaction;

  switch (interaction.commandName) {
    case "setup": {
      if (!context) throw new Error("Repository unavailable.");
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ ...ephemeral, content: "登録には「サーバー管理」権限が必要です。" });
        return;
      }
      const channel = interaction.channel;
      if (channel?.type !== ChannelType.GuildText ||
        !interaction.guild.members.me ||
        !channel.permissionsFor(interaction.guild.members.me)?.has([
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
        ])) {
        await interaction.reply({ ...ephemeral, content: "Bot が閲覧・投稿・履歴参照できるテキストチャンネルで実行してください。" });
        return;
      }
      context.repository.setOutputChannel(guildId, interaction.channelId);
      await interaction.reply({ ...ephemeral, content: "このチャンネルを要約投稿先に登録しました。" });
      return;
    }
    case "config": {
      if (!context) throw new Error("Repository unavailable.");
      const channelId = context.repository.getOutputChannel(guildId);
      await interaction.reply({ ...ephemeral, content: channelId
        ? `要約投稿先 <#${channelId}>\n/setup の変更は次の Session から反映します。options/ の変更反映には Bot・Worker の再起動が必要です。`
        : "投稿先が未登録です。投稿先で /setup を実行してください。" });
      return;
    }
    case "start": {
      if (context && !context.repository.getOutputChannel(guildId)) {
        await interaction.reply({ ...ephemeral, content: "要約を投稿するテキストチャンネルで /setup を実行してください。" });
        return;
      }
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
      if (result === "joined" && context) {
        const session = context.repository.activeSessions().find((item) => item.guildId === guildId && item.state === "running");
        if (session) {
          for (const member of channel.members.values()) {
            context.repository.addParticipant(session, member.id, true);
          }
        }
      }
      await interaction.editReply(joinMessage[result]);
      return;
    }
    case "stop": {
      await interaction.deferReply(ephemeral);
      const content = await voice.stop(guildId) ? "終了処理を行い、VC から退出しました。" : "接続中の VC はありません。";
      await interaction.editReply(content);
      return;
    }
    case "status": {
      const status = voice.status(guildId);
      const channel = status?.channelId ? ` <#${status.channelId}>` : "";
      const content = status
        ? `${status.state === "stopping" ? "最終要約を処理中" : status.state === VoiceConnectionStatus.Ready ? "接続中" : "接続処理中"}${channel}`
        : "接続中の VC はありません。";
      const sessions = context?.repository.activeSessions().filter((session) => session.guildId === guildId);
      const detail = sessions?.length ? `\nSession ${sessions[0]!.state}` : "";
      const load = context?.audioStats?.();
      const queue = load ? `\n全 Guild 共通の音声処理待ち ${load.queued} 件${load.paused ? "（取り込み停止中）" : ""}` : "";
      await interaction.reply({ ...ephemeral, content: content + detail + queue });
    }
  }
}
