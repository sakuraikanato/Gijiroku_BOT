import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const { Recognizer } = require(resolve(root, "target/napi/index.node")) as {
  Recognizer: new (model: string, language: string, threshold: number) => {
    transcribePcm(pcm: Buffer): Promise<string>;
    transcribeOpus(packets: Buffer[]): Promise<string>;
  };
};
const fixture = readFileSync(resolve(root, "models/audio-fixture.wav"));
assert.equal(fixture.toString("ascii", 0, 4), "RIFF");
let pcm: Buffer | undefined;
for (let index = 12; index + 8 <= fixture.length;) {
  const id = fixture.toString("ascii", index, index + 4);
  const size = fixture.readUInt32LE(index + 4);
  if (id === "fmt ") {
    assert.equal(fixture.readUInt16LE(index + 8), 1);
    assert.equal(fixture.readUInt16LE(index + 10), 1);
    assert.equal(fixture.readUInt32LE(index + 12), 16_000);
    assert.equal(fixture.readUInt16LE(index + 22), 16);
  }
  if (id === "data") pcm = fixture.subarray(index + 8, index + 8 + size);
  index += 8 + size + (size % 2);
}
assert(pcm && pcm.length);
const started = performance.now();
const recognizer = new Recognizer(resolve(root, "models/ggml-tiny.bin"), "en", 0.008);
const text = await recognizer.transcribePcm(pcm);
const durationSeconds = pcm.length / 32_000;
const processingSeconds = (performance.now() - started) / 1000;
assert.match(text.toLowerCase(), /meeting/);
assert.match(text.toLowerCase(), /report/);
const encoded = readFileSync(resolve(root, "models/audio-fixture.opuspackets"));
const packets: Buffer[] = [];
for (let index = 0; index + 4 < encoded.length;) {
  const size = encoded.readUInt32LE(index);
  packets.push(encoded.subarray(index + 4, index + 4 + size));
  index += 4 + size;
}
const opusStarted = performance.now();
const opusText = await recognizer.transcribeOpus(packets);
const opusProcessingSeconds = (performance.now() - opusStarted) / 1000;
assert.match(opusText.toLowerCase(), /meeting/);
assert.match(opusText.toLowerCase(), /report/);
assert.equal(await recognizer.transcribePcm(Buffer.alloc(32_000)), "");
await assert.rejects(recognizer.transcribePcm(Buffer.from([1])), /PCM/);
await assert.rejects(recognizer.transcribeOpus([Buffer.alloc(0)]), /Opus/);
console.log(JSON.stringify({
  durationSeconds, processingSeconds, realTimeFactor: processingSeconds / durationSeconds,
  opusProcessingSeconds, opusRealTimeFactor: opusProcessingSeconds / durationSeconds,
  passed: true,
}));
