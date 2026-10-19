import { afterEach, describe, expect, it, vi } from "vitest";
import { CallMedia } from "@/lib/direct-messages/call-media";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

const config = { iceTransportPolicy: "relay" as const, iceServers: [{ urls: "turns:relay.example.test:443?transport=tcp" }] };
function stream() {
  const track = { stop: vi.fn(), enabled: true, onended: null as (() => void) | null };
  const value = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  return { value, track };
}
function peer() {
  return { addTrack: vi.fn(), close: vi.fn(), ontrack: null, onconnectionstatechange: null } as unknown as RTCPeerConnection;
}
function audio() { return { autoplay: false, play: vi.fn(async () => undefined), pause: vi.fn(), srcObject: null } as unknown as HTMLAudioElement; }
afterEach(() => { vi.useRealTimers(); });

describe("foreground call media ownership", () => {
  it("stops permission results that arrive after cancellation without creating a connection", async () => {
    let resolve!: (stream: MediaStream) => void;
    const capture = vi.fn(() => new Promise<MediaStream>(done => { resolve = done; }));
    const connect = vi.fn(peer);
    const media = new CallMedia({ capture, connect, audio });
    const opening = media.open(config, vi.fn(), vi.fn());
    media.stop();
    const late = stream(); resolve(late.value);
    await expect(opening).rejects.toThrow("cancelled");
    expect(late.track.stop).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
  });

  it("releases the shared microphone lease and ends on device revocation", async () => {
    const captured = stream(); const connection = peer(); const ended = vi.fn();
    const media = new CallMedia({ capture: async () => captured.value, connect: () => connection, audio });
    await media.open(config, vi.fn(), ended);
    captured.track.onended?.();
    expect(ended).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(captured.track.stop).toHaveBeenCalledOnce();
    const next = appInteractionCoordinator.acquireVoiceLease({ owner: "synthetic-next", onRevoked: vi.fn() });
    expect(next.isCurrent()).toBe(true); next.release();
  });

  it("does not let an old playback rejection stop a newer call", async () => {
    let reject!: (reason: Error) => void;
    const firstAudio = audio(); firstAudio.play = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
    const first = stream(); const second = stream();
    const media = new CallMedia({ capture: vi.fn().mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value),
      connect: peer, audio: vi.fn().mockReturnValueOnce(firstAudio).mockReturnValueOnce(audio()) });
    const old = await media.open(config, vi.fn(), vi.fn());
    old.ontrack?.({ streams: [first.value] } as unknown as RTCTrackEvent);
    await media.open(config, vi.fn(), vi.fn());
    reject(new Error("synthetic playback failure")); await Promise.resolve();
    expect(second.track.stop).not.toHaveBeenCalled();
    media.stop(); expect(second.track.stop).toHaveBeenCalledOnce();
  });

  it("refuses non-relay configuration before opening the microphone", async () => {
    const capture = vi.fn(); const media = new CallMedia({ capture, connect: peer, audio });
    await expect(media.open({ ...config, iceTransportPolicy: "all" }, vi.fn(), vi.fn())).rejects.toThrow("relay");
    expect(capture).not.toHaveBeenCalled();
  });
});
