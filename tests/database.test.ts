import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRepository } from "../packages/shared/src/database";
import type { Job, LongContent, Scope, Session, ShortContent } from "../packages/shared/src/contracts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gijiroku-db-"));
  const path = join(directory, "test.sqlite");
  const repo = new SqliteRepository(path, 100);
  return {
    repo, path,
    close() {
      repo.close();
      rmSync(directory, { recursive: true });
    },
  };
}

function start(repo: SqliteRepository, guild = "guild-a", now = Date.now()) {
  repo.setOutputChannel(guild, "output-a");
  const session = repo.createSession(guild, "voice-a", now);
  repo.setSessionState(session, "running", now);
  return { ...session, state: "running" as const };
}

function transcript(repo: SqliteRepository, scope: Scope, sequence = 1, at = Date.now(), text = "議事録") {
  return repo.addTranscript({ ...scope, userId: "speaker-a", text, sequence, startedAt: at, endedAt: at + 10 });
}

function finishShort(repo: SqliteRepository, scope: Scope, text = "要点") {
  const job = repo.createShortJob(scope)!;
  expect(job).not.toBeNull();
  expect(repo.claimJob("worker", 10_000)?.id).toBe(job.id);
  const input = repo.jobInput(job);
  const content: ShortContent = { overview: text, sourceTranscriptIds: input.transcripts.map((row) => row.id) };
  const summary = repo.saveSummary(job, "worker", content, false);
  repo.recordPublication(summary, `message-${summary.id}`, null);
  repo.completeJob(job.id, "worker");
  return summary;
}

function longContent(repo: SqliteRepository, job: Job): LongContent {
  const input = repo.jobInput(job);
  return {
    overview: "累積状態", decisions: [], todos: [], topics: [],
    sourceShortSummaryIds: input.shortSummaries.map((row) => row.id),
  };
}

test("migrations are repeatable and SQLite preserves WAL and configured Guild output after reopening", () => {
  const f = fixture();
  try {
    f.repo.setOutputChannel("guild-a", "output-new");
    const second = new SqliteRepository(f.path, 101);
    try {
      expect(second.getOutputChannel("guild-a")).toBe("output-new");
      const raw = new Database(f.path);
      try {
        expect(raw.query("PRAGMA journal_mode").values()).toEqual([["wal"]]);
        expect(raw.query("SELECT COUNT(*) FROM schema_migrations").values()).toEqual([[1]]);
      } finally { raw.close(); }
    } finally { second.close(); }
  } finally { f.close(); }
});

test("Guild configuration is parameterized, Session output is snapshotted, and active Sessions are unique", () => {
  const f = fixture();
  try {
    const guild = "guild'); DROP TABLE guilds; --";
    const session = start(f.repo, guild);
    f.repo.setOutputChannel(guild, "future-output");
    expect(f.repo.getSession(session)?.outputChannelId).toBe("output-a");
    expect(f.repo.getOutputChannel(guild)).toBe("future-output");
    expect(() => f.repo.createSession(guild, "other-voice")).toThrow();
    expect(f.repo.getOutputChannel("other-guild")).toBeNull();
    expect(() => f.repo.createSession("other-guild", "voice")).toThrow();
    expect(() => f.repo.setSessionState(session, "starting")).toThrow();
  } finally { f.close(); }
});

test("composite FKs and Repository checks prevent Guild/Session crossing in transcripts, jobs and details", () => {
  const f = fixture();
  try {
    const a = start(f.repo, "guild-a");
    const b = start(f.repo, "guild-b");
    const t = transcript(f.repo, a);
    const job = f.repo.createShortJob(a)!;
    expect(f.repo.claimJob("worker", 10_000)?.id).toBe(job.id);
    expect(() => f.repo.jobInput({ ...job, guildId: b.guildId })).toThrow();
    expect(() => transcript(f.repo, { guildId: b.guildId, sessionId: a.sessionId })).toThrow();

    const raw = new Database(f.path);
    try {
      raw.exec("PRAGMA foreign_keys=ON");
      expect(() => raw.query("INSERT INTO summary_job_transcripts VALUES(?,?,?,?,?)")
        .run(b.guildId, b.sessionId, job.id, t.id, 2)).toThrow();
    } finally { raw.close(); }

    const summary = f.repo.saveSummary(job, "worker", { overview: "概要", sourceTranscriptIds: [t.id] }, false);
    expect(f.repo.summaryDetails(b, "short", summary.id)).toBeNull();
    expect(f.repo.summaryDetails(a, "short", summary.id)?.transcripts.map((row) => row.id)).toEqual([t.id]);
  } finally { f.close(); }
});

test("acquisition time and sequence determine frozen transcript order, with no overlapping short jobs", () => {
  const f = fixture();
  try {
    const session = start(f.repo);
    const later = transcript(f.repo, session, 3, 3000);
    const simultaneousSecond = transcript(f.repo, session, 2, 1000);
    const simultaneousFirst = transcript(f.repo, session, 1, 1000);
    const job = f.repo.createShortJob(session)!;
    expect(f.repo.jobInput(job).transcripts.map((row) => row.id))
      .toEqual([simultaneousFirst.id, simultaneousSecond.id, later.id]);
    expect(f.repo.createShortJob(session)).toBeNull();
    expect(f.repo.pendingStats(session).characters).toBe(0);
    expect(() => transcript(f.repo, session, 1)).toThrow();
  } finally { f.close(); }
});

test("pending audio with an earlier acquisition key blocks later ASR completions from summarization", () => {
  const f = fixture();
  try {
    const session = start(f.repo);
    f.repo.beginAudio(session, 2, 1000);
    const earlier = transcript(f.repo, session, 1, 1000);
    const later = transcript(f.repo, session, 3, 1000);
    const first = f.repo.createShortJob(session)!;
    expect(f.repo.jobInput(first).transcripts.map((row) => row.id)).toEqual([earlier.id]);
    expect(f.repo.createShortJob(session)).toBeNull();
    const delayed = transcript(f.repo, session, 2, 1000);
    f.repo.endAudio(session, 2);
    const second = f.repo.createShortJob(session)!;
    expect(f.repo.jobInput(second).transcripts.map((row) => row.id)).toEqual([delayed.id, later.id]);
  } finally { f.close(); }
});

test("leases survive independent connections and fence expired owners and out-of-order same Session jobs", () => {
  const f = fixture();
  const second = new SqliteRepository(f.path);
  try {
    const a = start(f.repo, "guild-a");
    transcript(f.repo, a, 1);
    const firstJob = f.repo.createShortJob(a)!;
    transcript(f.repo, a, 2);
    const secondJob = f.repo.createShortJob(a)!;
    const b = start(f.repo, "guild-b");
    transcript(f.repo, b, 1);
    const otherJob = f.repo.createShortJob(b)!;
    const now = Date.now();
    expect(f.repo.claimJob("old-owner", 30, now)?.id).toBe(firstJob.id);
    expect(second.claimJob("other-owner", 1000, now)?.id).toBe(otherJob.id);
    expect(second.claimJob("next-owner", 1000, now)).toBeNull();
    expect(second.claimJob("new-owner", 1000, now + 31)?.id).toBe(firstJob.id);
    expect(f.repo.renewLease(firstJob.id, "old-owner", 1000, now + 32)).toBe(false);
    const content = { overview: "概要", sourceTranscriptIds: f.repo.jobInput(firstJob).transcripts.map((row) => row.id) };
    expect(() => f.repo.saveSummary(firstJob, "old-owner", content, false, now + 32)).toThrow("lease");
    const summary = second.saveSummary(firstJob, "new-owner", content, false, now + 32);
    expect(second.saveSummary(firstJob, "new-owner", content, false, now + 32).id).toBe(summary.id);
    expect(() => f.repo.completeJob(firstJob.id, "old-owner")).toThrow("lease");
    second.completeJob(firstJob.id, "new-owner");
    expect(f.repo.claimJob("next-owner", 1000, now + 33)?.id).toBe(secondJob.id);
  } finally { second.close(); f.close(); }
});

test("saved results reserve publication and crash recovery records interruption without automatic resend", () => {
  const f = fixture();
  try {
    const session = start(f.repo);
    transcript(f.repo, session);
    const job = f.repo.createShortJob(session)!;
    const now = Date.now();
    expect(f.repo.claimJob("crashed-worker", 30, now)?.id).toBe(job.id);
    const content = { overview: "フォールバック", sourceTranscriptIds: f.repo.jobInput(job).transcripts.map((row) => row.id) };
    const summary = f.repo.saveSummary(job, "crashed-worker", content, true, now);
    expect(f.repo.claimJob("recovery", 1000, now + 10)).toBeNull();
    expect(f.repo.hasPendingJobs(session)).toBe(true);
    expect(f.repo.claimJob("recovery", 1000, now + 31)).toBeNull();
    expect(f.repo.hasPendingJobs(session)).toBe(false);
    expect(f.repo.summaryDetails(session, "short", summary.id)?.summary.fallback).toBe(true);
    expect(f.repo.createShortJob(session)).toBeNull();
    const raw = new Database(f.path);
    try {
      expect(raw.query("SELECT publication_error FROM short_summaries WHERE id=?").values(summary.id))
        .toEqual([["publication_interrupted"]]);
    } finally { raw.close(); }
  } finally { f.close(); }
});

test("publication failure preserves summaries and input text while sanitizing external error strings", () => {
  const f = fixture();
  try {
    const session = start(f.repo);
    const t = transcript(f.repo, session, 1, Date.now(), "API障害時も保存する発言");
    const job = f.repo.createShortJob(session)!;
    f.repo.claimJob("worker", 1000);
    const summary = f.repo.saveSummary(job, "worker", { overview: "生ログ", sourceTranscriptIds: [t.id] }, true);
    f.repo.recordPublication(summary, null, "Authorization: SECRET; utterance: PRIVATE");
    f.repo.completeJob(job.id, "worker");
    const details = f.repo.summaryDetails(session, "short", summary.id)!;
    expect(details.transcripts[0]?.text).toBe(t.text);
    expect(f.repo.claimJob("worker", 1000)).toBeNull();
    const raw = new Database(f.path);
    try {
      const serialized = JSON.stringify(raw.query("SELECT publication_error FROM short_summaries").all());
      expect(serialized).toContain("discord_publication_failed");
      expect(serialized).not.toContain("SECRET");
      expect(serialized).not.toContain("PRIVATE");
    } finally { raw.close(); }
  } finally { f.close(); }
});

test("long summaries freeze exact new short IDs, update imports atomically, and include cumulative references", () => {
  const f = fixture();
  try {
    const session = start(f.repo);
    const firstTranscript = transcript(f.repo, session, 1, 1000);
    const firstShort = finishShort(f.repo, session);
    const firstJob = f.repo.createLongJob(session)!;
    expect(f.repo.createLongJob(session)).toBeNull();
    expect(f.repo.jobInput(firstJob).shortSummaries.map((row) => row.id)).toEqual([firstShort.id]);
    f.repo.claimJob("worker", 10_000);
    const firstLong = f.repo.saveSummary(firstJob, "worker", longContent(f.repo, firstJob), false);
    f.repo.completeJob(firstJob.id, "worker");
    expect(f.repo.pendingStats(session).shortCount).toBe(0);
    expect(f.repo.createLongJob(session)).toBeNull();

    const secondTranscript = transcript(f.repo, session, 2, 2000);
    const secondShort = finishShort(f.repo, session);
    const nextJob = f.repo.createLongJob(session, true)!;
    const input = f.repo.jobInput(nextJob);
    expect(input.previousLongSummary?.id).toBe(firstLong.id);
    expect(input.shortSummaries.map((row) => row.id)).toEqual([secondShort.id]);
    expect(input.transcripts.map((row) => row.id)).toEqual([firstTranscript.id, secondTranscript.id]);
    f.repo.claimJob("worker", 10_000);
    expect(() => f.repo.saveSummary(nextJob, "worker", {
      ...longContent(f.repo, nextJob), sourceShortSummaryIds: [firstShort.id],
    }, false)).toThrow("sources");
    const final = f.repo.saveSummary(nextJob, "worker", longContent(f.repo, nextJob), false);
    f.repo.completeJob(nextJob.id, "worker");
    expect(f.repo.summaryDetails(session, "long", final.id)?.shortSummaries.map((row) => row.id)).toEqual([secondShort.id]);
    expect(f.repo.pendingStats(session).shortCount).toBe(0);
  } finally { f.close(); }
});

test("summary reference validation rejects IDs from another Session before writing output", () => {
  const f = fixture();
  try {
    const a = start(f.repo, "guild-a");
    const b = start(f.repo, "guild-b");
    transcript(f.repo, a);
    const foreign = transcript(f.repo, b);
    const job = f.repo.createShortJob(a)!;
    f.repo.claimJob("worker", 1000);
    expect(() => f.repo.saveSummary(job, "worker", { overview: "攻撃", sourceTranscriptIds: [foreign.id] }, false))
      .toThrow("outside");
    expect(f.repo.summaryDetails(a, "short", 1)).toBeNull();
  } finally { f.close(); }
});

test("startup recovery ends starting Sessions, drains running/stopping Sessions, and drops volatile audio", () => {
  const f = fixture();
  try {
    f.repo.setOutputChannel("starting-guild", "output");
    const starting = f.repo.createSession("starting-guild", "voice");
    const running = start(f.repo, "running-guild");
    const stopping = start(f.repo, "stopping-guild");
    f.repo.addParticipant(running, "user", true);
    f.repo.beginAudio(running, 1, Date.now());
    f.repo.setSessionState(stopping, "stopping");
    f.repo.recoverSessions();
    expect(f.repo.getSession(starting)?.state).toBe("ended");
    expect(f.repo.getSession(running)?.state).toBe("stopping");
    expect(f.repo.getSession(stopping)?.state).toBe("stopping");
    expect(() => transcript(f.repo, running)).toThrow("not accepting");
    const raw = new Database(f.path);
    try {
      expect(raw.query("SELECT COUNT(*) FROM pending_audio").values()).toEqual([[0]]);
      expect(raw.query("SELECT reason FROM audio_losses").values()).toEqual([["volatile_audio_lost_on_restart"]]);
      expect(raw.query("SELECT COUNT(*) FROM participants WHERE left_at IS NULL").values()).toEqual([[0]]);
    } finally { raw.close(); }
  } finally { f.close(); }
});

test("retention deletion cascades through summary cycles and preserves other Guilds and live Sessions", () => {
  const f = fixture();
  try {
    const now = Date.now();
    const old = start(f.repo, "old-guild", now - 400 * 86400_000);
    transcript(f.repo, old);
    finishShort(f.repo, old);
    const longJob = f.repo.createLongJob(old, true)!;
    f.repo.claimJob("worker", 1000);
    f.repo.saveSummary(longJob, "worker", longContent(f.repo, longJob), false);
    f.repo.completeJob(longJob.id, "worker");
    f.repo.setSessionState(old, "stopping");
    f.repo.setSessionState(old, "ended", now - 366 * 86400_000);
    const live = start(f.repo, "live-guild");
    expect(f.repo.purgeExpired(365, now)).toBe(1);
    expect(f.repo.getSession(old)).toBeNull();
    expect(f.repo.getSession(live)?.state).toBe("running");
    const raw = new Database(f.path);
    try {
      expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(raw.query("SELECT COUNT(*) FROM summary_jobs").values()).toEqual([[0]]);
      expect(raw.query("SELECT COUNT(*) FROM transcripts").values()).toEqual([[0]]);
    } finally { raw.close(); }
  } finally { f.close(); }
});

test("participant rejoining preserves each visit and Session ending requires all persisted inputs to be processed", () => {
  const f = fixture();
  try {
    const session = start(f.repo);
    f.repo.addParticipant(session, "same-user", true, 1000);
    f.repo.addParticipant(session, "same-user", true, 1100);
    f.repo.addParticipant(session, "same-user", false, 2000);
    f.repo.addParticipant(session, "same-user", true, 3000);
    transcript(f.repo, session);
    f.repo.setSessionState(session, "stopping");
    expect(() => f.repo.setSessionState(session, "ended")).toThrow("unfinished");
    const raw = new Database(f.path);
    try {
      expect(raw.query("SELECT joined_at,left_at FROM participants ORDER BY joined_at").values())
        .toEqual([[1000, 2000], [3000, null]]);
    } finally { raw.close(); }
  } finally { f.close(); }
});
