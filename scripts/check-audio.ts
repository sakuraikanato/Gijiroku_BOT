import assert from "node:assert/strict";

const { audioProbe, audioBufferProbe } = require("../target/napi/index.node");

assert.equal(audioProbe(), 42);
assert.equal(await audioBufferProbe(Buffer.from([17, 23])), 17);
await assert.rejects(audioBufferProbe(Buffer.alloc(0)), /empty buffer/);
console.log("Bun loaded the audio module and verified its synchronous and asynchronous exports.");
