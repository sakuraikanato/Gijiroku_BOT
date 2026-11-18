import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadOptions } from "../packages/shared/src/options";
import { SqliteRepository } from "../packages/shared/src/database";
import { tickRepository } from "../packages/shared/src/scheduling";
import type { Session } from "../packages/shared/src/contracts";

const options = loadOptions(fileURLToPath(new URL("../options", import.meta.url)));

function createSession(repository: SqliteRepository, now: number): Session {
  repository.setOutputChannel("guild-schedule", "summary-channel");
  const session = repository.createSession("guild-schedule", "voice-channel", now);
  repository.setSessionState(session, "running", now);
  return session;
}

function transcript(repository: SqliteRepository, session: Session, text: string, now: number) {
  repository.addTranscript({
    guildId: session.guildId, sessionId: session.sessionId,
    userId: "speaker", text, sequence: 1, startedAt: now, endedAt: now,
  });
}

test("uses configured character debounce and suppresses duplicate trigger jobs", () => {
  const repository = new SqliteRepository(":memory:");
  const now = Date.now();
  const session = createSession(repository, now);
  try {
    const settings = structuredClone(options);
    settings.summary.short.characterThreshold = 4;
    settings.summary.short.debounceSeconds = 2;
    settings.summary.short.elapsedSeconds = 1000;
    settings.summary.short.silenceSeconds = 1000;
    transcript(repository, session, "abcdef", now);
    tickRepository(repository, settings, now);
    tickRepository(repository, settings, now + 1999);
    expect(repository.hasPendingJobs(session)).toBe(false);
    tickRepository(repository, settings, now + 2000);
    expect(repository.hasPendingJobs(session)).toBe(true);
    tickRepository(repository, settings, now + 3000);
    const job = repository.claimJob("worker", 100000, now + 3000)!;
    expect(job.kind).toBe("short");
    expect(repository.jobInput(job).transcripts).toHaveLength(1);
    expect(repository.claimJob("other-worker", 100000, now + 3000)).toBeNull();
  } finally {
    repository.close();
  }
});

test("silence and elapsed-time triggers require new transcripts and honor configured boundaries", () => {
  for (const trigger of ["silence", "elapsed"] as const) {
    const repository = new SqliteRepository(":memory:");
    const now = Date.now();
    const session = createSession(repository, now);
    try {
      const settings = structuredClone(options);
      settings.summary.short.characterThreshold = 1000;
      settings.summary.short.silenceSeconds = trigger === "silence" ? 2 : 1000;
      settings.summary.short.elapsedSeconds = trigger === "elapsed" ? 2 : 1000;
      tickRepository(repository, settings, now + 10000);
      expect(repository.hasPendingJobs(session)).toBe(false);
      transcript(repository, session, "test", now);
      tickRepository(repository, settings, now + 1999);
      expect(repository.hasPendingJobs(session)).toBe(false);
      tickRepository(repository, settings, now + 2000);
      expect(repository.hasPendingJobs(session)).toBe(true);
    } finally {
      repository.close();
    }
  }
});

test("empty sessions end without generating empty summaries, while starting sessions stay starting", () => {
  const repository = new SqliteRepository(":memory:");
  const now = Date.now();
  try {
    const session = createSession(repository, now);
    repository.setSessionState(session, "stopping", now);
    tickRepository(repository, options, now);
    expect(repository.getSession(session)?.state).toBe("ended");
    const starting = repository.createSession("guild-schedule", "voice-channel", now);
    tickRepository(repository, options, now + 1_000_000);
    expect(repository.getSession(starting)?.state).toBe("starting");
    expect(repository.hasPendingJobs(starting)).toBe(false);
  } finally {
    repository.close();
  }
});
