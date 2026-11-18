import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { VoiceConnection } from "@discordjs/voice";
import { AudioPipeline } from "@gijiroku/shared/audio";
import { SqliteRepository } from "@gijiroku/shared/database";
import { loadOptions } from "@gijiroku/shared/options";
import { fileURLToPath } from "node:url";
import { captureVoice } from "./capture";

test("capture preserves speaker/time metadata, splits bounded packets, and flushes the last segment", async () => {
  const repository = new SqliteRepository(":memory:");
  const options = loadOptions(fileURLToPath(new URL("../../../options/", import.meta.url)));
  repository.setOutputChannel("123456789012345678", "234567890123456789");
  const session = repository.createSession("123456789012345678", "345678901234567890");
  repository.setSessionState(session, "running");
  const received: number[] = [];
  const pipeline = new AudioPipeline(options.asr, {
    onTranscript(input) { repository.addTranscript(input); received.push(input.sequence); },
    onLoad() {},
    onLoss(scope, reason) { repository.recordAudioLoss(scope, reason); },
    onSettled(scope, sequence) { repository.endAudio(scope, sequence); },
  }, ".", async () => "synthetic transcript");
  const speaking = new EventEmitter();
  const stream = new PassThrough({ objectMode: true });
  const connection = { receiver: { speaking, subscribe: () => stream } };
  const stop = captureVoice(connection as unknown as VoiceConnection, session, pipeline, repository);
  try {
    speaking.emit("start", "456789012345678901");
    for (let index = 0; index < 501; index++) stream.write(Buffer.from([1, 2]));
    stop();
    await pipeline.flush(session);
    const job = repository.createShortJob(session);
    expect(job).toBeTruthy();
    const input = repository.jobInput(job!);
    expect(received).toEqual([1, 2]);
    expect(input.transcripts.map((item) => item.userId)).toEqual(["456789012345678901", "456789012345678901"]);
    expect(input.transcripts[0]!.startedAt).toBeLessThanOrEqual(input.transcripts[0]!.endedAt);
    expect(input.transcripts[0]!.sequence).toBeLessThan(input.transcripts[1]!.sequence);
  } finally {
    stop();
    await pipeline.close();
    repository.close();
  }
});
