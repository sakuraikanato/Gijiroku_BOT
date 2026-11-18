import { expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteRepository } from "../../../packages/shared/src/database";
import { loadOptions } from "../../../packages/shared/src/options";
import { tickRepository } from "../../../packages/shared/src/scheduling";
import type { JobInput, LongContent, Scope, Summary } from "../../../packages/shared/src/contracts";
import { processOne } from "./processor";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const options = loadOptions(join(root, "options"));
const guildId = "123456789012345678";
const userId = "223456789012345678";

function setup(path = ":memory:") {
  const repository = new SqliteRepository(path);
  repository.setOutputChannel(guildId, "323456789012345678");
  const session = repository.createSession(guildId, "423456789012345678");
  repository.setSessionState(session, "running");
  return { repository, session };
}

function addTranscript(repository: SqliteRepository, scope: Scope, sequence: number, text = "作業を進めます。") {
  const now = Date.now();
  return repository.addTranscript({
    guildId: scope.guildId, sessionId: scope.sessionId, userId, sequence, text,
    startedAt: now - 1000 + sequence,
    endedAt: now - 500 + sequence,
  });
}

function mockProvider() {
  return { summarize: mock(async (input: JobInput): Promise<unknown> => {
    if (input.job.kind === "short") {
      return { overview: input.transcripts.map((transcript) => transcript.text).join("\n"), sourceTranscriptIds: input.transcripts.map((transcript) => transcript.id) };
    }
    return {
      overview: "累積要約",
      decisions: [],
      todos: [],
      topics: [],
      sourceShortSummaryIds: input.shortSummaries.map((summary) => summary.id),
    };
  }) };
}

test("commits before posting, preserves raw logs on failure, and never regenerates a fallback interval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gijiroku-worker-"));
  const path = join(directory, "test.sqlite");
  const { repository, session } = setup(path);
  const provider = { summarize: mock(async () => { throw new Error("private-key should never enter database"); }) };
  let posted: Summary | undefined;
  const publisher = {
    publish: mock(async (summary: Summary) => {
      posted = summary;
      expect(repository.summaryDetails(summary, "short", summary.id)?.summary.fallback).toBe(true);
      throw new Error("private Discord token must stay outside database");
    }),
  };
  try {
    const transcript = addTranscript(repository, session, 1);
    expect(repository.createShortJob(session)).not.toBeNull();
    expect(await processOne(repository, options, { provider, publisher })).toBe(true);
    expect(posted?.fallback).toBe(true);
    expect(posted?.content.overview).toContain(transcript.text);
    expect(repository.summaryDetails(session, "short", posted!.id)?.transcripts).toEqual([transcript]);
    expect(repository.createShortJob(session)).toBeNull();
    expect(await processOne(repository, options, { provider: mockProvider(), publisher })).toBe(false);
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const inspection = new Database(path, { readonly: true });
    try {
      expect(inspection.query("SELECT publication_error FROM short_summaries").get())
        .toEqual({ publication_error: "discord_publication_failed" });
      expect(inspection.query("SELECT state FROM summary_jobs").get()).toEqual({ state: "done" });
    } finally {
      inspection.close();
    }
  } finally {
    repository.close();
    rmSync(directory, { recursive: true });
  }
});

test("missing API key, invalid JSON/IDs, and a provider that never settles all produce durable fallback", async () => {
  const cases = [
    undefined,
    { summarize: async () => "invalid structured response" },
    { summarize: async () => ({ overview: "foreign", sourceTranscriptIds: [999999] }) },
    { summarize: () => new Promise<never>(() => {}) },
  ];
  for (const provider of cases) {
    const { repository, session } = setup();
    const configured = structuredClone(options);
    configured.ai.timeoutMs = 15;
    let posted: Summary | undefined;
    try {
      addTranscript(repository, session, 1);
      repository.createShortJob(session);
      await processOne(repository, configured, {
        provider, environment: {},
        publisher: { publish: async (summary) => { posted = summary; return "message"; } },
      });
      expect(posted?.fallback).toBe(true);
      expect(repository.hasPendingJobs(session)).toBe(false);
    } finally {
      repository.close();
    }
  }
});

test("updates cumulative TODO state and binds each long summary to its own short-summary delta", async () => {
  const { repository, session } = setup();
  const published: Summary[] = [];
  const publisher = { publish: async (summary: Summary) => { published.push(summary); return String(summary.id); } };
  const provider = mockProvider();
  try {
    const first = addTranscript(repository, session, 1, "作業を開始します。");
    repository.createShortJob(session);
    await processOne(repository, options, { provider, publisher });
    const firstShort = published.at(-1)!;
    repository.createLongJob(session);
    const firstContent: LongContent = {
      overview: "作業を開始", decisions: [], topics: [],
      todos: [{ assigneeId: userId, content: "作業", status: "pending", sourceTranscriptIds: [first.id] }],
      sourceShortSummaryIds: [firstShort.id],
    };
    await processOne(repository, options, { provider: { summarize: async () => firstContent }, publisher });
    const firstLong = published.at(-1)!;
    expect(repository.summaryDetails(session, "long", firstLong.id)?.shortSummaries.map((summary) => summary.id)).toEqual([firstShort.id]);

    const second = addTranscript(repository, session, 2, "作業が完了しました。");
    repository.createShortJob(session);
    await processOne(repository, options, { provider, publisher });
    const secondShort = published.at(-1)!;
    repository.createLongJob(session);
    await processOne(repository, options, {
      provider: { summarize: async (input) => {
        expect(input.previousLongSummary?.id).toBe(firstLong.id);
        expect(input.shortSummaries.map((summary) => summary.id)).toEqual([secondShort.id]);
        expect(input.transcripts.map((transcript) => transcript.id)).toEqual([first.id, second.id]);
        return {
          ...firstContent, overview: "作業完了",
          todos: [{ ...firstContent.todos[0], status: "completed", sourceTranscriptIds: [first.id, second.id] }],
          sourceShortSummaryIds: [secondShort.id],
        };
      } },
      publisher,
    });
    const secondLong = published.at(-1)!;
    expect((secondLong.content as LongContent).todos[0]?.status).toBe("completed");
    expect(repository.summaryDetails(session, "long", secondLong.id)?.shortSummaries.map((summary) => summary.id)).toEqual([secondShort.id]);
    expect(repository.createLongJob(session)).toBeNull();
    expect(published.map((summary) => summary.kind)).toEqual(["short", "long", "short", "long"]);
  } finally {
    repository.close();
  }
});

test("renews a short lease during slow AI work and publishes once", async () => {
  const { repository, session } = setup();
  const configured = structuredClone(options);
  configured.worker.leaseDurationMs = 90;
  const publisher = { publish: mock(async () => "message") };
  try {
    addTranscript(repository, session, 1);
    repository.createShortJob(session);
    const processing = processOne(repository, configured, {
      owner: "worker-a",
      provider: { summarize: async (input) => {
        await Bun.sleep(150);
        expect(repository.claimJob("worker-b", 90)).toBeNull();
        return { overview: "要約", sourceTranscriptIds: input.transcripts.map((transcript) => transcript.id) };
      } },
      publisher,
    });
    await processing;
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(repository.hasPendingJobs(session)).toBe(false);
  } finally {
    repository.close();
  }
});

test("recovers work after a worker process exits and finishes stopped sessions without reconnecting", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gijiroku-crash-"));
  const path = join(directory, "test.sqlite");
  const { repository, session } = setup(path);
  const publisher = { publish: mock(async () => "message") };
  try {
    addTranscript(repository, session, 1);
    repository.createShortJob(session);
    const childSource = `
      import { SqliteRepository } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/shared/src/database.ts", import.meta.url)))};
      const repository = new SqliteRepository(${JSON.stringify(path)});
      const job = repository.claimJob("crashed-worker", 30);
      if (!job) process.exit(1);
      process.exit(23);
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", childSource], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(23);
    await Bun.sleep(60);
    expect(await processOne(repository, options, { provider: mockProvider(), publisher })).toBe(true);
    repository.setSessionState(session, "stopping");
    tickRepository(repository, options);
    expect(await processOne(repository, options, { provider: mockProvider(), publisher })).toBe(true);
    tickRepository(repository, options);
    expect(repository.getSession(session)?.state).toBe("ended");
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(repository.activeSessions()).toEqual([]);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true });
  }
});

test("fences publication when a heartbeat loses its lease while an AI request is running", async () => {
  const { repository, session } = setup();
  const configured = structuredClone(options);
  configured.worker.leaseDurationMs = 30;
  const publisher = { publish: mock(async () => "message") };
  try {
    addTranscript(repository, session, 1);
    repository.createShortJob(session);
    const renew = spyOn(repository, "renewLease").mockReturnValue(false);
    expect(await processOne(repository, configured, {
      provider: { summarize: () => new Promise<never>(() => {}) },
      publisher,
    })).toBe(true);
    expect(renew).toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(repository.hasPendingJobs(session)).toBe(true);
    renew.mockRestore();
  } finally {
    repository.close();
  }
});

test("a generated summary survives a worker process exit without duplicate AI or Discord output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gijiroku-generated-crash-"));
  const path = join(directory, "test.sqlite");
  const { repository, session } = setup(path);
  const provider = mockProvider();
  const publisher = { publish: mock(async () => "message") };
  try {
    const transcript = addTranscript(repository, session, 1);
    repository.createShortJob(session);
    const childSource = `
      import { SqliteRepository } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/shared/src/database.ts", import.meta.url)))};
      const repository = new SqliteRepository(${JSON.stringify(path)});
      const job = repository.claimJob("crashed-worker", 100);
      repository.saveSummary(job, "crashed-worker", { overview: "保存済み", sourceTranscriptIds: [${transcript.id}] }, false);
      process.exit(23);
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", childSource], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(23);
    await Bun.sleep(120);
    expect(await processOne(repository, options, { provider, publisher })).toBe(false);
    expect(provider.summarize).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(repository.hasPendingJobs(session)).toBe(false);
    const inspection = new Database(path, { readonly: true });
    try {
      expect(inspection.query("SELECT COUNT(*) AS count FROM short_summaries").get()).toEqual({ count: 1 });
      expect(inspection.query("SELECT publication_error FROM short_summaries").get())
        .toEqual({ publication_error: "publication_interrupted" });
    } finally {
      inspection.close();
    }
  } finally {
    repository.close();
    rmSync(directory, { recursive: true });
  }
});

test("long fallback preserves raw intervals even when AI becomes available on later jobs", async () => {
  const { repository, session } = setup();
  const provider = mockProvider();
  const published: Summary[] = [];
  const publisher = { publish: async (summary: Summary) => { published.push(summary); return "message"; } };
  try {
    addTranscript(repository, session, 1, "フォールバック期間の発言");
    repository.createShortJob(session);
    await processOne(repository, options, { environment: {}, publisher });
    repository.createLongJob(session);
    await processOne(repository, options, { provider, publisher });
    expect(provider.summarize).not.toHaveBeenCalled();
    expect(published.at(-1)?.fallback).toBe(true);
    expect(published.at(-1)?.content.overview).toContain("フォールバック期間の発言");

    addTranscript(repository, session, 2, "AI 復帰後の発言");
    repository.createShortJob(session);
    await processOne(repository, options, { provider, publisher });
    expect(published.at(-1)?.fallback).toBe(false);
    repository.createLongJob(session);
    await processOne(repository, options, { provider, publisher });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(published.at(-1)?.fallback).toBe(true);
    expect(published.at(-1)?.content.overview).toContain("フォールバック期間の発言");
    expect(published.at(-1)?.content.overview).toContain("AI 復帰後の発言");
  } finally {
    repository.close();
  }
});
