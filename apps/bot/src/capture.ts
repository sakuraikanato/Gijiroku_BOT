import { EndBehaviorType, type VoiceConnection } from "@discordjs/voice";
import type { AudioPipeline } from "@gijiroku/shared/audio";
import type { Repository, Scope } from "@gijiroku/shared/contracts";

/** Each stream is split into bounded utterances with a capture-time ordering key. */
export function captureVoice(
  connection: VoiceConnection,
  scope: Scope,
  audio: AudioPipeline,
  repository: Repository,
) {
  let sequence = 0;
  const subscriptions = new Map<string, () => void>();
  const subscribe = (userId: string) => {
    if (subscriptions.has(userId)) return;
    const stream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
    });
    let packets: Buffer[] = [];
    let bytes = 0;
    let startedAt = 0;
    let endedAt = 0;
    let chunkSequence = 0;
    let stopped = false;

    function flush() {
      if (!packets.length) return;
      const accepted = audio.accept(scope, userId, packets, startedAt, endedAt, chunkSequence);
      if (!accepted) repository.endAudio(scope, chunkSequence);
      packets = [];
      bytes = 0;
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      flush();
      subscriptions.delete(userId);
      stream.destroy();
    }

    subscriptions.set(userId, stop);
    stream.on("data", (packet: Buffer) => {
      if (stopped) return;
      if (packet.length > 16_384) {
        repository.recordAudioLoss(scope, "oversized_opus_packet");
        return;
      }
      const now = Date.now();
      if (packets.length && (packets.length >= 500 || bytes + packet.length > 512_000 || now - startedAt >= 10_000)) flush();
      if (!packets.length) {
        startedAt = now;
        chunkSequence = ++sequence;
        repository.beginAudio(scope, chunkSequence, startedAt);
      }
      endedAt = now;
      packets.push(Buffer.from(packet));
      bytes += packet.length;
    });
    stream.once("end", stop);
    stream.once("close", stop);
    stream.once("error", () => {
      repository.recordAudioLoss(scope, "opus_receive_failed");
      stop();
    });
  };

  connection.receiver.speaking.on("start", subscribe);
  return () => {
    connection.receiver.speaking.off("start", subscribe);
    for (const stop of [...subscriptions.values()]) stop();
  };
}
