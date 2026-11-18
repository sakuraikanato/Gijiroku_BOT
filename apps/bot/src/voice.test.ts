import { expect, test } from "bun:test";
import { getVoiceConnection, VoiceConnectionStatus, type DiscordGatewayAdapterLibraryMethods } from "@discordjs/voice";
import { VoiceSessions } from "./voice";

function gatewayVoice(guildId: string, channelId: string, acceptsRequests = true) {
  const packets: { channel_id: string | null; guild_id: string; self_mute: boolean; self_deaf: boolean }[] = [];
  let adapter: DiscordGatewayAdapterLibraryMethods | undefined;
  let destroyed = false;
  return {
    target: {
      guildId,
      channelId,
      adapterCreator(methods: DiscordGatewayAdapterLibraryMethods) {
        adapter = methods;
        return {
          sendPayload(payload: { d: (typeof packets)[number] }) {
            packets.push(payload.d);
            return acceptsRequests;
          },
          destroy() { destroyed = true; },
        };
      },
    },
    packets,
    removeAdapter() { adapter?.destroy(); },
    get destroyed() { return destroyed; },
  };
}

test("uses one voice connection per Guild and releases only the requested Guild", async () => {
  const voice = new VoiceSessions(async (connection) => connection);
  const a = gatewayVoice("guild-a", "channel-a");
  const b = gatewayVoice("guild-b", "channel-b");
  try {
    expect(await voice.start(a.target)).toBe("joined");
    expect(await voice.start(b.target)).toBe("joined");
    expect(a.packets).toEqual([{
      guild_id: "guild-a", channel_id: "channel-a", self_deaf: true, self_mute: true,
    }]);
    expect(await voice.start({ ...a.target, channelId: "other-channel" })).toBe("already-active");
    expect(voice.status("guild-a")?.channelId).toBe("channel-a");
    const aConnection = getVoiceConnection("guild-a");
    expect(aConnection).toBeDefined();

    expect(voice.stop("guild-a")).toBe(true);
    expect(voice.stop("guild-a")).toBe(false);
    expect(a.packets.at(-1)?.channel_id).toBeNull();
    expect(aConnection?.state.status).toBe(VoiceConnectionStatus.Destroyed);
    expect(a.destroyed).toBe(true);
    expect(getVoiceConnection("guild-a")).toBeUndefined();
    expect(voice.status("guild-b")?.channelId).toBe("channel-b");
    expect(b.packets).toHaveLength(1);
  } finally {
    voice.close();
  }
  expect(b.packets.at(-1)?.channel_id).toBeNull();
  expect(b.destroyed).toBe(true);
});

test("shutdown promptly cancels every pending join and rejects further starts", async () => {
  const voice = new VoiceSessions();
  const a = gatewayVoice("pending-a", "channel-a");
  const b = gatewayVoice("pending-b", "channel-b");
  const pending = [voice.start(a.target), voice.start(b.target)];
  expect(await voice.start(a.target)).toBe("already-active");
  expect(voice.status("pending-a")?.state).toBe(VoiceConnectionStatus.Signalling);

  voice.close();
  expect(await Promise.all(pending)).toEqual(["cancelled", "cancelled"]);
  expect([a.packets.at(-1)?.channel_id, b.packets.at(-1)?.channel_id]).toEqual([null, null]);
  expect([a.destroyed, b.destroyed]).toEqual([true, true]);
  expect(await voice.start(a.target)).toBe("cancelled");
});

test("allows a retry after an unavailable gateway adapter or a failed voice handshake", async () => {
  const rejected = gatewayVoice("retry-guild", "channel-a", false);
  const timeout = gatewayVoice("retry-guild", "channel-a");
  const replacement = gatewayVoice("retry-guild", "channel-b");
  let waits = 0;
  const voice = new VoiceSessions(async (connection) => {
    if (waits++ === 0) throw new Error("simulated handshake failure");
    return connection;
  });
  try {
    expect(await voice.start(rejected.target)).toBe("failed");
    expect(rejected.destroyed).toBe(true);
    expect(await voice.start(timeout.target)).toBe("failed");
    expect(timeout.destroyed).toBe(true);
    expect(voice.status("retry-guild")).toBeUndefined();
    expect(await voice.start(replacement.target)).toBe("joined");
    replacement.removeAdapter();
    expect(voice.status("retry-guild")).toBeUndefined();
  } finally {
    voice.close();
  }
});
