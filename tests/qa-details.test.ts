import { expect, test } from "bun:test";
import { showSummaryDetails } from "../apps/bot/src/details";
import { SqliteRepository } from "../packages/shared/src/database";

function detailsFixture() {
  const repository = new SqliteRepository(":memory:");
  repository.setOutputChannel("guild-a", "private-summary-channel");
  const session = repository.createSession("guild-a", "voice-channel");
  repository.setSessionState(session, "running");
  const source = repository.addTranscript({
    ...session, userId: "speaker", startedAt: 1000, endedAt: 2000, sequence: 1,
    text: "決定しました。🙂".repeat(400) + "@everyone",
  });
  const job = repository.createShortJob(session)!;
  repository.claimJob("worker", 10_000);
  const summary = repository.saveSummary(job, "worker", {
    overview: "要点", sourceTranscriptIds: [source.id],
  }, false);
  repository.completeJob(job.id, "worker");
  return { repository, session, summary, source };
}

function button(customId: string, guildId = "guild-a", permitted = true) {
  const replies: unknown[] = [];
  const fetches: string[] = [];
  let deferred = false;
  const interaction = {
    customId, guildId, member: { id: "viewer" },
    guild: {
      channels: {
        async fetch(id: string) {
          fetches.push(id);
          return { permissionsFor: () => ({ has: () => permitted }) };
        },
      },
    },
    async deferReply() { deferred = true; },
    async editReply(message: unknown) { replies.push(message); },
  } as unknown as Parameters<typeof showSummaryDetails>[0];
  return { interaction, replies, fetches, isDeferred: () => deferred };
}

test("summary buttons reject another Guild and denied output-channel permissions before returning any transcript", async () => {
  const f = detailsFixture();
  try {
    const customId = `summary:short:${f.session.sessionId}:${f.summary.id}:0`;
    const wrongGuild = button(customId, "guild-b");
    await showSummaryDetails(wrongGuild.interaction, f.repository);
    expect(wrongGuild.isDeferred()).toBe(true);
    expect(wrongGuild.fetches).toEqual([]);
    expect(wrongGuild.replies).toEqual(["この要約を閲覧する権限がありません。"]);

    const denied = button(customId, "guild-a", false);
    await showSummaryDetails(denied.interaction, f.repository);
    expect(denied.fetches).toEqual(["private-summary-channel"]);
    expect(denied.replies).toEqual(["この要約を閲覧する権限がありません。"]);
    expect(JSON.stringify(denied.replies)).not.toContain("決定しました");
  } finally { f.repository.close(); }
});

test("authorized transcript buttons page Unicode source text with mentions disabled", async () => {
  const f = detailsFixture();
  try {
    const first = button(`summary:short:${f.session.sessionId}:${f.summary.id}:0`);
    await showSummaryDetails(first.interaction, f.repository);
    const reply = first.replies[0] as { content: string; components: unknown[]; allowedMentions: { parse: string[] } };
    expect(reply.content.length).toBeLessThanOrEqual(2000);
    expect(reply.content).toContain("<@speaker>");
    expect(reply.allowedMentions.parse).toEqual([]);
    expect(reply.components).toHaveLength(1);
    expect(reply.content).not.toMatch(/[\uD800-\uDBFF]$/);

    const last = button(`summary:short:${f.session.sessionId}:${f.summary.id}:999`);
    await showSummaryDetails(last.interaction, f.repository);
    const lastReply = last.replies[0] as typeof reply;
    expect(lastReply.content.length).toBeLessThanOrEqual(2000);
    expect(lastReply.content).toContain("@everyone");
    expect(lastReply.allowedMentions.parse).toEqual([]);
  } finally { f.repository.close(); }
});

test("malformed summary button IDs do not read the database or defer unrelated interactions", async () => {
  const repository = new SqliteRepository(":memory:");
  try {
    const malicious = button("summary:short:session');DROP TABLE sessions;--:1:0");
    await showSummaryDetails(malicious.interaction, repository);
    expect(malicious.isDeferred()).toBe(false);
    expect(malicious.fetches).toEqual([]);
    expect(malicious.replies).toEqual([]);
  } finally { repository.close(); }
});
