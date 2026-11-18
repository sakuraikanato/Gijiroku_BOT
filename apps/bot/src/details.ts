import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, type ButtonInteraction } from "discord.js";
import type { Repository } from "@gijiroku/shared/contracts";

export async function showSummaryDetails(interaction: ButtonInteraction<"cached">, repository: Repository) {
  const match = /^summary:(short|long):([a-zA-Z0-9-]{1,64}):([1-9][0-9]*):([0-9]+)$/.exec(interaction.customId);
  if (!match) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const [, kind, sessionId, idText, pageText] = match;
  const scope = { guildId: interaction.guildId, sessionId: sessionId! };
  const session = repository.getSession(scope);
  const output = session ? await interaction.guild.channels.fetch(session.outputChannelId).catch(() => null) : null;
  if (!output?.permissionsFor(interaction.member)?.has([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
  ])) {
    await interaction.editReply("この要約を閲覧する権限がありません。");
    return;
  }
  const details = repository.summaryDetails(scope, kind as "short" | "long", Number(idText));
  if (!details) {
    await interaction.editReply("要約が見つかりません。保存期限を過ぎている可能性があります。");
    return;
  }
  const text = kind === "short"
    ? details.transcripts.map((item) => `${new Date(item.startedAt).toISOString()} <@${item.userId}>\n${item.text}`).join("\n\n")
    : details.shortSummaries.map((item) => item.content.overview).join("\n\n");
  const pages: string[] = [];
  let page = "";
  for (const character of text || "表示する内容がありません。") {
    if (page.length + character.length > 1700) { pages.push(page); page = ""; }
    page += character;
  }
  pages.push(page);
  const index = Math.min(Number(pageText), pages.length - 1);
  if (!Number.isSafeInteger(index)) {
    await interaction.editReply("ページ番号が不正です。");
    return;
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`summary:${kind}:${sessionId}:${idText}:${Math.max(0, index - 1)}`)
      .setLabel("前へ").setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId(`summary:${kind}:${sessionId}:${idText}:${index + 1}`)
      .setLabel("次へ").setStyle(ButtonStyle.Secondary).setDisabled(index === pages.length - 1),
  );
  await interaction.editReply({
    content: `${index + 1}/${pages.length}\n${pages[index]}`,
    components: pages.length > 1 ? [row] : [],
    allowedMentions: { parse: [] },
  });
}
