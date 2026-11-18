import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { VoiceConnectionStatus, getVoiceConnection } from "@discordjs/voice";
import type { AppOptions } from "@gijiroku/shared/options";
import type { AudioPipeline } from "@gijiroku/shared/audio";
import type { Repository, Session } from "@gijiroku/shared/contracts";
import { captureVoice } from "./capture";
import { VoiceSessions } from "./voice";

type ActiveRecording = {
  session: Session;
  stopCapture?: () => void;
  joining?: ReturnType<VoiceSessions["start"]>;
};

export class RecordingSessions {
  private readonly sessions = new Map<string, ActiveRecording>();
  private readonly stopping = new Map<string, Promise<boolean>>();
  private closing = false;
  private readonly monitor: ReturnType<typeof setInterval>;

  constructor(
    private readonly repository: Repository,
    private readonly audio: AudioPipeline,
    private readonly options: AppOptions,
    private readonly root: string,
    private readonly voice = new VoiceSessions(),
  ) {
    this.monitor = setInterval(() => {
      for (const [guildId] of this.sessions) {
        if (!this.voice.status(guildId) && !this.stopping.has(guildId)) {
          void this.stop(guildId).catch(() => console.error("切断後の Session を終了できませんでした。"));
        }
      }
    }, 1000);
  }

  async start(target: Parameters<VoiceSessions["start"]>[0]) {
    if (this.closing) return "cancelled" as const;
    if (this.sessions.has(target.guildId)) return "already-active" as const;
    if (!existsSync(join(this.root, "target/napi/index.node")) ||
      !existsSync(resolve(this.root, this.options.asr.modelPath))) {
      throw new Error("音声モジュールと Whisper モデルを準備してください。");
    }
    this.audio.prepare();
    const session = this.repository.createSession(target.guildId, target.channelId);
    const value: ActiveRecording = { session };
    this.sessions.set(target.guildId, value);
    try {
      value.joining = this.voice.start(target);
      const result = await value.joining;
      if (result !== "joined") {
        this.repository.setSessionState(session, "ended");
        this.sessions.delete(target.guildId);
        return result;
      }
      if (this.closing || this.stopping.has(target.guildId)) return "cancelled" as const;
      this.repository.setSessionState(session, "running");
      session.state = "running";
      const connection = getVoiceConnection(target.guildId);
      if (!connection) throw new Error("VC 接続を確認できませんでした。");
      value.stopCapture = captureVoice(connection, session, this.audio, this.repository, this.options.asr.blacklistedUserIds);
      return "joined" as const;
    } catch (error) {
      const state = this.repository.getSession(session)?.state;
      if (state === "starting") this.repository.setSessionState(session, "ended");
      if (state === "running") this.repository.setSessionState(session, "stopping");
      this.sessions.delete(target.guildId);
      this.voice.stop(target.guildId);
      throw error;
    }
  }

  status(guildId: string) {
    const value = this.sessions.get(guildId);
    const status = this.voice.status(guildId);
    if (!value) return undefined;
    return {
      channelId: value.session.voiceChannelId,
      state: this.stopping.has(guildId) ? "stopping" : status?.state ?? VoiceConnectionStatus.Disconnected,
    };
  }

  stop(guildId: string): Promise<boolean> {
    const pending = this.stopping.get(guildId);
    if (pending) return pending;
    const value = this.sessions.get(guildId);
    if (!value) return Promise.resolve(false);
    const operation = (async () => {
      try {
        if (value.session.state === "starting") {
          this.voice.stop(guildId);
          await value.joining;
          this.repository.setSessionState(value.session, "ended");
          return true;
        }
        value.stopCapture?.();
        await this.audio.flush(value.session);
        this.repository.setSessionState(value.session, "stopping");
        // The separate Worker commits the final summaries before the VC is released.
        while (this.repository.getSession(value.session)?.state !== "ended") {
          await Bun.sleep(250);
        }
        return true;
      } finally {
        this.voice.stop(guildId);
        this.sessions.delete(guildId);
        this.stopping.delete(guildId);
      }
    })();
    this.stopping.set(guildId, operation);
    return operation;
  }

  active() {
    return [...this.sessions.values()].map(({ session }) => session);
  }

  async close() {
    this.closing = true;
    clearInterval(this.monitor);
    await Promise.all([...this.sessions.keys()].map((guildId) => this.stop(guildId)));
    this.voice.close();
    await this.audio.close();
  }
}
