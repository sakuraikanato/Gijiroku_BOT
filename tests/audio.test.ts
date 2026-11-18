import { expect, test } from "bun:test";
import { AudioPipeline } from "../packages/shared/src/audio";
import { loadOptions } from "../packages/shared/src/options";
import type { TranscriptInput } from "../packages/shared/src/contracts";

const defaults = loadOptions("options").asr;
const a = { guildId: "guild-a", sessionId: "session-a" };
const b = { guildId: "guild-b", sessionId: "session-b" };
const packets = [Buffer.from([0xf8, 0xff, 0xfe])];
const options = {
  ...defaults,
  maxParallelTasks: 2,
  queue: { maxItems: 6, warningThreshold: 3, pauseThreshold: 5, resumeBelow: 3 },
};

test("global queue pauses all Guilds, resumes below threshold and flushes each scope", async () => {
  const completed: TranscriptInput[] = [];
  const loads: string[] = [];
  const losses: string[] = [];
  const settled: number[] = [];
  const tasks: ReturnType<typeof Promise.withResolvers<string>>[] = [];
  let active = 0;
  let maxActive = 0;
  const audio = new AudioPipeline(options, {
    onTranscript: (input) => completed.push(input),
    onLoad: (event) => loads.push(event),
    onLoss: (scope, reason) => losses.push(`${scope.guildId}:${reason}`),
    onSettled: (_scope, sequence) => settled.push(sequence),
  }, ".", async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    const task = Promise.withResolvers<string>();
    tasks.push(task);
    try { return await task.promise; }
    finally { active--; }
  });

  for (let i = 0; i < 5; i++) {
    expect(audio.accept(i % 2 ? b : a, "user", packets, 100 + i, 200 + i, i)).toBe(true);
  }
  expect(audio.stats()).toEqual({ queued: 5, paused: true });
  expect(loads).toEqual(["warning", "paused"]);
  expect(audio.accept(b, "user", packets, 500, 600, 6)).toBe(false);
  expect(losses).toEqual(["guild-b:audio_queue_paused"]);
  expect(tasks).toHaveLength(2);

  // Finish out of capture order, metadata must still use acquisition times.
  tasks[1]!.resolve("later captured");
  await Bun.sleep(1);
  tasks[0]!.resolve("earlier captured");
  await Bun.sleep(1);
  tasks[2]!.resolve("third captured");
  await Bun.sleep(1);
  expect(audio.stats()).toEqual({ queued: 2, paused: false });
  expect(loads).toEqual(["warning", "paused", "resumed"]);

  let bFlushed = false;
  const bDone = audio.flush(b).then(() => { bFlushed = true; });
  expect(bFlushed).toBe(false);
  tasks[3]!.resolve("fourth captured");
  await bDone;
  expect(bFlushed).toBe(true);
  expect(audio.stats().queued).toBe(1);
  tasks[4]!.resolve("fifth captured");
  await audio.flush(a);
  expect(audio.stats().queued).toBe(0);
  expect(maxActive).toBe(2);
  expect(completed[0]).toMatchObject({ ...b, startedAt: 101, endedAt: 201, sequence: 1, userId: "user" });
  expect(completed[1]).toMatchObject({ ...a, startedAt: 100, endedAt: 200, sequence: 0 });
  expect(settled.sort()).toEqual([0, 1, 2, 3, 4]);
  await audio.close();
});

test("blacklist, bounded malformed buffers, recognition failures and silence are accounted for", async () => {
  const losses: string[] = [];
  const outputs: TranscriptInput[] = [];
  const settled: number[] = [];
  let attempts = 0;
  const audio = new AudioPipeline({ ...defaults, blacklistedUserIds: ["blocked"] }, {
    onTranscript: (input) => outputs.push(input),
    onLoad: () => {},
    onLoss: (_scope, reason) => losses.push(reason),
    onSettled: (_scope, sequence) => settled.push(sequence),
  }, ".", async () => {
    if (attempts++ === 0) throw new Error("simulated native failure");
    return "";
  });
  expect(audio.accept(a, "blocked", packets, 0, 100, 0)).toBe(false);
  expect(audio.accept(a, "user", [Buffer.alloc(4097)], 0, 100, 1)).toBe(false);
  expect(audio.accept(a, "user", packets, 100, 0, 2)).toBe(false);
  expect(audio.accept(a, "user", packets, 0, 100, 3)).toBe(true);
  expect(audio.accept(a, "user", packets, 0, 100, 4)).toBe(true);
  await audio.close();
  expect(losses).toEqual(["invalid_audio_segment", "invalid_audio_segment", "audio_processing_failed"]);
  expect(outputs).toEqual([]);
  expect(settled).toEqual([3, 4]);
  expect(audio.accept(b, "user", packets, 0, 100, 5)).toBe(false);
  expect(losses.at(-1)).toBe("audio_closed");
});

test("configured threshold boundaries remain bounded under synthetic multi-Session load", async () => {
  const { warningThreshold, pauseThreshold, maxItems } = defaults.queue;
  const requests: ReturnType<typeof Promise.withResolvers<string>>[] = [];
  const loads: string[] = [];
  let losses = 0;
  const audio = new AudioPipeline({ ...defaults, maxParallelTasks: 1 }, {
    onTranscript: () => {},
    onLoss: () => { losses++; },
    onLoad: (event) => loads.push(event),
  }, ".", async () => {
    const request = Promise.withResolvers<string>();
    requests.push(request);
    return request.promise;
  });
  for (let i = 0; i < maxItems + 10; i++) {
    const accepted = audio.accept(i % 2 ? a : b, "user", packets, i, i + 1, i);
    expect(accepted).toBe(i < pauseThreshold);
    expect(audio.stats().queued).toBeLessThanOrEqual(maxItems);
    if (i === warningThreshold - 1) expect(loads).toEqual(["warning"]);
  }
  expect(loads).toEqual(["warning", "paused"]);
  expect(losses).toBe(maxItems + 10 - pauseThreshold);
  for (let i = 0; i < pauseThreshold; i++) {
    requests[i]!.resolve("");
    await Bun.sleep(0);
  }
  await audio.close();
  expect(loads).toEqual(["warning", "paused", "resumed"]);
});
