import {
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";

type VoiceTarget = {
  guildId: string;
  channelId: string;
  adapterCreator: DiscordGatewayAdapterCreator;
};
type StartResult = "joined" | "already-active" | "cancelled" | "failed";
type EndReason = Extract<StartResult, "cancelled" | "failed">;

type VoiceSession = {
  connection: VoiceConnection;
  abort: AbortController;
};

function waitForReady(connection: VoiceConnection, signal: AbortSignal) {
  return entersState(
    connection,
    VoiceConnectionStatus.Ready,
    AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  );
}

export class VoiceSessions {
  private readonly sessions = new Map<string, VoiceSession>();
  private closed = false;

  constructor(private readonly wait = waitForReady) {}

  async start(target: VoiceTarget): Promise<StartResult> {
    const { guildId } = target;
    if (this.closed) return "cancelled";
    if (this.sessions.has(guildId)) return "already-active";

    const connection = joinVoiceChannel({ ...target, selfMute: true, selfDeaf: false });
    const session = { connection, abort: new AbortController() };
    this.sessions.set(guildId, session);

    const releaseIfCurrent = () => {
      if (this.sessions.get(guildId) === session) this.release(guildId, "failed");
    };
    connection.on("error", () => {
      console.error("Discord VC の接続でエラーが発生しました。");
      releaseIfCurrent();
    });
    connection.on("stateChange", (_, state) => {
      if (
        state.status === VoiceConnectionStatus.Destroyed ||
        state.status === VoiceConnectionStatus.Disconnected
      ) {
        releaseIfCurrent();
      }
    });

    try {
      if (connection.state.status === VoiceConnectionStatus.Disconnected) {
        this.release(guildId, "failed");
      } else {
        await this.wait(connection, session.abort.signal);
      }
    } catch {
      releaseIfCurrent();
    }
    if (!session.abort.signal.aborted) return "joined";
    return session.abort.signal.reason === "failed" ? "failed" : "cancelled";
  }

  status(guildId: string) {
    const connection = this.sessions.get(guildId)?.connection;
    if (!connection) return undefined;
    return { channelId: connection.joinConfig.channelId, state: connection.state.status };
  }

  stop(guildId: string): boolean {
    return this.release(guildId, "cancelled");
  }

  private release(guildId: string, reason: EndReason): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;

    this.sessions.delete(guildId);
    session.abort.abort(reason);
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      session.connection.destroy();
    }
    return true;
  }

  close() {
    this.closed = true;
    for (const guildId of this.sessions.keys()) this.stop(guildId);
  }
}
