import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { captureVoice } from "../apps/bot/src/capture";
import { AudioPipeline } from "../packages/shared/src/audio";
import { SqliteRepository } from "../packages/shared/src/database";
import { loadOptions } from "../packages/shared/src/options";

test("capture drops packets acquired during the global pause even if the queue resumes before utterance end", async () => {
  const repository = new SqliteRepository(":memory:");
  repository.setOutputChannel("captured-guild", "output");
  repository.setOutputChannel("background-guild", "output");
  const capture = repository.createSession("captured-guild", "voice");
  const background = repository.createSession("background-guild", "other-voice");
  repository.setSessionState(capture, "running");
  repository.setSessionState(background, "running");
  const barrier = Promise.withResolvers<void>();
  const processed: number[] = [];
  const pipeline = new AudioPipeline({
    ...loadOptions("options").asr,
    maxParallelTasks: 1,
    queue: { maxItems: 3, warningThreshold: 1, pauseThreshold: 2, resumeBelow: 1 },
  }, {
    onTranscript() {},
    onLoad() {},
    onLoss(scope, reason) { repository.recordAudioLoss(scope, reason); },
    onSettled(scope, sequence) { repository.endAudio(scope, sequence); },
  }, ".", async (packets) => {
    for (const packet of packets) processed.push(packet[0]!);
    await barrier.promise;
    return "";
  });
  const speaking = new EventEmitter();
  const stream = new PassThrough({ objectMode: true });
  const connection = { receiver: { speaking, subscribe: () => stream } };
  const stop = captureVoice(connection as unknown as Parameters<typeof captureVoice>[0], capture, pipeline, repository);
  try {
    expect(pipeline.accept(background, "background", [Buffer.from([1])], 1, 2, 10)).toBe(true);
    expect(pipeline.accept(background, "background", [Buffer.from([2])], 3, 4, 11)).toBe(true);
    expect(pipeline.stats().paused).toBe(true);
    speaking.emit("start", "speaker");
    stream.write(Buffer.from([5]));
    barrier.resolve();
    await pipeline.flush(background);
    expect(pipeline.stats().paused).toBe(false);
    stream.write(Buffer.from([6]));
    stop();
    await pipeline.flush(capture);
    expect(processed).toEqual([1, 2, 6]);
  } finally {
    barrier.resolve();
    stop();
    await pipeline.close();
    repository.close();
  }
});
