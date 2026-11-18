import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AudioPipeline } from "../packages/shared/src/audio";
import { SqliteRepository } from "../packages/shared/src/database";
import { loadOptions } from "../packages/shared/src/options";
import { tickRepository } from "../packages/shared/src/scheduling";
import { processOne } from "../apps/worker/src/processor";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = loadOptions(resolve(root, "options"));
options.asr.language = "en";
const fixture = readFileSync(resolve(root, "models/audio-fixture.opuspackets"));
const packets: Buffer[] = [];
for (let index = 0; index < fixture.length;) {
  assert(index + 4 <= fixture.length);
  const size = fixture.readUInt32LE(index);
  assert(size > 0 && index + 4 + size <= fixture.length);
  packets.push(fixture.subarray(index + 4, index + 4 + size));
  index += 4 + size;
}
const repository = new SqliteRepository(":memory:");
repository.setOutputChannel("123456789012345678", "234567890123456789");
const session = repository.createSession("123456789012345678", "345678901234567890");
repository.setSessionState(session, "running");
let transcriptId: number | undefined;
let posted = 0;
const pipeline = new AudioPipeline(options.asr, {
  onTranscript(input) {
    assert.equal(input.userId, "456789012345678901");
    assert.equal(input.startedAt, 1000);
    assert.equal(input.sequence, 1);
    assert.match(input.text.toLowerCase(), /meeting/);
    assert.match(input.text.toLowerCase(), /report/);
    transcriptId = repository.addTranscript(input).id;
  },
  onSettled(scope, sequence) { repository.endAudio(scope, sequence); },
  onLoad() {},
  onLoss() { throw new Error("Unexpected audio loss"); },
}, root);
try {
  pipeline.prepare();
  repository.beginAudio(session, 1, 1000);
  assert(pipeline.accept(session, "456789012345678901", packets, 1000, 6260, 1));
  await pipeline.flush(session);
  assert(transcriptId);
  repository.setSessionState(session, "stopping");
  const dependencies = {
    environment: {},
    publisher: {
      async publish() {
        posted++;
        return "567890123456789012";
      },
    },
  };
  for (let index = 0; index < 10 && repository.getSession(session)?.state !== "ended"; index++) {
    tickRepository(repository, options);
    await processOne(repository, options, dependencies);
  }
  assert.equal(repository.getSession(session)?.state, "ended");
  assert.equal(posted, 2);
  console.log("Native Opus -> VAD -> ASR -> scoped SQLite -> short/long fallback -> ended Session passed.");
} finally {
  await pipeline.close();
  repository.close();
}
