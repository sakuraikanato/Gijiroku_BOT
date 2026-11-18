import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Scope, TranscriptInput } from "./contracts";
import type { AppOptions } from "./options";

type LoadEvent = "warning" | "paused" | "resumed";
type AudioCallbacks = {
  onTranscript(input: TranscriptInput): void;
  onLoad(event: LoadEvent): void;
  onLoss(scope: Scope, reason: string): void;
  onSettled?(scope: Scope, sequence: number): void;
};
type Segment = Scope & {
  userId: string;
  packets: Buffer[];
  startedAt: number;
  endedAt: number;
  sequence: number;
};
type Processor = (packets: Buffer[]) => Promise<string>;
type NativeRecognizer = { transcribeOpus(packets: Buffer[]): Promise<string> };

export class AudioPipeline {
  private readonly waiting: Segment[] = [];
  private readonly counts = new Map<string, number>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private active = 0;
  private paused = false;
  private warned = false;
  private closed = false;
  private recognizer?: NativeRecognizer;
  private readonly processSegment: Processor;

  constructor(
    private readonly options: AppOptions["asr"],
    private readonly callbacks: AudioCallbacks,
    private readonly rootPath: string,
    processor?: Processor,
  ) {
    this.processSegment = processor ?? ((packets) => {
      this.prepare();
      return this.recognizer!.transcribeOpus(packets);
    });
  }

  /** Loads and validates the model before joining voice. */
  prepare() {
    if (this.recognizer) return;
    const model = resolve(this.rootPath, this.options.modelPath);
    if (!existsSync(model)) throw new Error("options/asr.json の modelPath に Whisper モデルがありません。");
    const modulePath = join(this.rootPath, "target", "napi", "index.node");
    if (!existsSync(modulePath)) throw new Error("音声モジュールを bun run build:audio でビルドしてください。");
    const native = require(modulePath) as {
      Recognizer: new (path: string, language: string, threshold: number) => NativeRecognizer;
    };
    this.recognizer = new native.Recognizer(model, this.options.language, this.options.vadThreshold ?? 0.008);
  }

  accept(scope: Scope, userId: string, packets: Buffer[], startedAt: number, endedAt: number, sequence: number): boolean {
    if (this.options.blacklistedUserIds.includes(userId)) return false;
    if (this.closed || this.paused || this.size >= this.options.queue.maxItems) {
      this.callbacks.onLoss(scope, this.closed ? "audio_closed" : "audio_queue_paused");
      return false;
    }
    const valid = packets.length > 0 && packets.length <= 600 &&
      packets.every((packet) => packet.length > 0 && packet.length <= 4096) &&
      packets.reduce((bytes, packet) => bytes + packet.length, 0) <= 512 * 1024 &&
      Number.isSafeInteger(sequence) && sequence >= 0 &&
      Number.isSafeInteger(startedAt) && Number.isSafeInteger(endedAt) &&
      startedAt >= 0 && endedAt >= startedAt && endedAt - startedAt <= 12_000;
    if (!valid) {
      this.callbacks.onLoss(scope, "invalid_audio_segment");
      return false;
    }
    this.waiting.push({ ...scope, userId, packets: packets.map((packet) => Buffer.from(packet)), startedAt, endedAt, sequence });
    const key = this.key(scope);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.updateLoad();
    this.pump();
    return true;
  }

  stats() {
    return { queued: this.size, paused: this.paused };
  }

  flush(scope: Scope): Promise<void> {
    const key = this.key(scope);
    if (!this.counts.has(key)) return Promise.resolve();
    return new Promise((resolveFlush) => {
      const pending = this.waiters.get(key) ?? new Set();
      pending.add(resolveFlush);
      this.waiters.set(key, pending);
    });
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.counts.keys()].map((key) => new Promise<void>((resolveFlush) => {
      const pending = this.waiters.get(key) ?? new Set();
      pending.add(resolveFlush);
      this.waiters.set(key, pending);
    })));
    this.recognizer = undefined;
  }

  private get size() {
    return this.waiting.length + this.active;
  }

  private key(scope: Scope) {
    return JSON.stringify([scope.guildId, scope.sessionId]);
  }

  private updateLoad() {
    const { warningThreshold, pauseThreshold, resumeBelow } = this.options.queue;
    if (!this.warned && this.size >= warningThreshold) {
      this.warned = true;
      this.callbacks.onLoad("warning");
    }
    if (!this.paused && this.size >= pauseThreshold) {
      this.paused = true;
      this.callbacks.onLoad("paused");
    }
    if (this.size < resumeBelow) {
      const wasPaused = this.paused;
      this.paused = false;
      this.warned = false;
      if (wasPaused) this.callbacks.onLoad("resumed");
    }
  }

  private pump() {
    while (this.active < this.options.maxParallelTasks && this.waiting.length) {
      const segment = this.waiting.shift()!;
      this.active++;
      void this.run(segment);
    }
  }

  private async run(segment: Segment) {
    try {
      const text = (await this.processSegment(segment.packets)).trim();
      if (text) {
        const { packets: _packets, ...input } = segment;
        this.callbacks.onTranscript({ ...input, text });
      }
    } catch {
      try {
        this.callbacks.onLoss(segment, "audio_processing_failed");
      } catch {
        console.error("音声処理の欠落情報を保存できませんでした。");
      }
    } finally {
      try {
        this.callbacks.onSettled?.(segment, segment.sequence);
      } catch {
        console.error("音声処理の完了状態を保存できませんでした。");
      }
      this.active--;
      const key = this.key(segment);
      const remaining = this.counts.get(key)! - 1;
      if (remaining) {
        this.counts.set(key, remaining);
      } else {
        this.counts.delete(key);
        for (const finish of this.waiters.get(key) ?? []) finish();
        this.waiters.delete(key);
      }
      this.updateLoad();
      this.pump();
    }
  }
}
