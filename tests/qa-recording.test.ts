import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingSessions } from "../apps/bot/src/recording";
import { VoiceSessions } from "../apps/bot/src/voice";
import { processOne } from "../apps/worker/src/processor";
import { tickRepository } from "../packages/shared/src/scheduling";
import type { AudioPipeline } from "../packages/shared/src/audio";
import { SqliteRepository } from "../packages/shared/src/database";
import { loadOptions } from "../packages/shared/src/options";

test("stop during the initial voice handshake cancels promptly and ends starting Session without invalid transitions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gijiroku-recording-"));
  const repository = new SqliteRepository(":memory:");
  const options = loadOptions("options");
  mkdirSync(join(directory, "target/napi"), { recursive: true });
  mkdirSync(join(directory, "models"), { recursive: true });
  writeFileSync(join(directory, "target/napi/index.node"), "");
  writeFileSync(join(directory, options.asr.modelPath), "");
  const packets: (string | null)[] = [];
  const audio = {
    prepare() {},
    async flush() {},
    async close() {},
  } as unknown as AudioPipeline;
  const recording = new RecordingSessions(repository, audio, options, directory);
  repository.setOutputChannel("handshake-test-guild", "output-channel");
  try {
    const start = recording.start({
      guildId: "handshake-test-guild",
      channelId: "voice-channel",
      adapterCreator: () => ({
        sendPayload(payload: { d: { channel_id: string | null } }) {
          packets.push(payload.d.channel_id);
          return true;
        },
        destroy() {},
      }),
    });
    const session = repository.activeSessions()[0]!;
    expect(session.state).toBe("starting");
    const stopping = recording.stop(session.guildId);
    expect(await start).toBe("cancelled");
    expect(await stopping).toBe(true);
    expect(repository.getSession(session)?.state).toBe("ended");
    expect(recording.status(session.guildId)).toBeUndefined();
    expect(await recording.stop(session.guildId)).toBe(false);
    expect(packets).toEqual(["voice-channel", null]);
    expect(repository.hasPendingJobs(session)).toBe(false);
  } finally {
    await recording.close();
    repository.close();
    rmSync(directory, { recursive: true });
  }
});

test("running shutdown persists and publishes both final summaries before releasing voice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gijiroku-final-output-"));
  const repository = new SqliteRepository(":memory:");
  const options = loadOptions("options");
  mkdirSync(join(directory, "target/napi"), { recursive: true });
  mkdirSync(join(directory, "models"), { recursive: true });
  writeFileSync(join(directory, "target/napi/index.node"), "");
  writeFileSync(join(directory, options.asr.modelPath), "");
  const order: string[] = [];
  const audio = {
    prepare() {},
    async flush() { order.push("audio-flushed"); },
    async close() { order.push("audio-closed"); },
  } as unknown as AudioPipeline;
  const voice = new VoiceSessions(async (connection) => connection);
  const recording = new RecordingSessions(repository, audio, options, directory, voice);
  repository.setOutputChannel("final-output-guild", "output-channel");
  let shutdown: Promise<void> | undefined;
  try {
    expect(await recording.start({
      guildId: "final-output-guild", channelId: "voice-channel",
      adapterCreator: () => ({
        sendPayload(payload: { d: { channel_id: string | null } }) {
          if (payload.d.channel_id === null) {
            expect(repository.activeSessions()).toEqual([]);
            expect(order).toEqual(["audio-flushed", "published-short", "published-long"]);
            order.push("voice-left");
          }
          return true;
        },
        destroy() {},
      }),
    })).toBe("joined");
    const session = repository.activeSessions()[0]!;
    repository.addTranscript({
      ...session, userId: "speaker", text: "テスト発言", sequence: 1,
      startedAt: Date.now(), endedAt: Date.now(),
    });
    shutdown = recording.close();
    await Bun.sleep(1);
    expect(repository.getSession(session)?.state).toBe("stopping");
    expect(order).toEqual(["audio-flushed"]);

    for (let step = 0; step < 6 && repository.getSession(session)?.state !== "ended"; step++) {
      tickRepository(repository, options);
      await processOne(repository, options, {
        environment: {},
        provider: {
          async summarize(input) {
            if (input.job.kind === "short") {
              return { overview: "短期要約", sourceTranscriptIds: input.transcripts.map((row) => row.id) };
            }
            return {
              overview: "長期要約", decisions: [], todos: [], topics: [],
              sourceShortSummaryIds: input.shortSummaries.map((row) => row.id),
            };
          },
        },
        publisher: {
          async publish(summary) {
            expect(repository.summaryDetails(session, summary.kind, summary.id)).not.toBeNull();
            order.push(`published-${summary.kind}`);
            return `message-${summary.kind}`;
          },
        },
      });
    }
    expect(repository.getSession(session)?.state).toBe("ended");
    await shutdown;
    expect(order).toEqual(["audio-flushed", "published-short", "published-long", "voice-left", "audio-closed"]);
  } finally {
    if (!shutdown) await recording.close();
    repository.close();
    rmSync(directory, { recursive: true });
  }
});
