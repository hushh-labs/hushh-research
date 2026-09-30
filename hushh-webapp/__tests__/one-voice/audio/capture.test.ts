import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveAudioCapture } from "@/lib/one-voice/audio/capture";

afterEach(() => vi.unstubAllGlobals());

describe("LiveAudioCapture microphone ownership", () => {
  it("releases a late permission grant after Stop without starting a worklet", async () => {
    let grant!: (stream: MediaStream) => void;
    const stop = vi.fn();
    const stream = {
      getAudioTracks: () => [],
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    const capture = new LiveAudioCapture({
      getUserMedia: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    });
    const starting = capture.start({
      audioContext: {} as AudioContext,
      onFrame: vi.fn(),
    });

    capture.stop();
    grant(stream);

    await expect(starting).rejects.toMatchObject({ code: "not_readable" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(capture.running).toBe(false);
  });

  it("releases a track ended by the OS and reports the loss once", async () => {
    const track = new EventTarget() as MediaStreamTrack;
    const stop = vi.fn();
    Object.assign(track, {
      readyState: "live",
      stop,
      getSettings: () => ({ echoCancellation: true }),
    });
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const node = { port: { onmessage: null }, disconnect: vi.fn() };
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        port = node.port;
        disconnect = node.disconnect;
      },
    );
    const context = {
      sampleRate: 48_000,
      state: "running",
      audioWorklet: { addModule: vi.fn(async () => undefined) },
      createMediaStreamSource: () => source,
      close: vi.fn(async () => undefined),
    } as unknown as AudioContext;
    const onEnded = vi.fn();
    const capture = new LiveAudioCapture({ getUserMedia: async () => stream });

    await capture.start({ audioContext: context, onFrame: vi.fn(), onEnded });
    expect(capture.running).toBe(true);
    expect(capture.isTrackLive()).toBe(true);
    track.dispatchEvent(new Event("ended"));
    track.dispatchEvent(new Event("ended"));

    expect(capture.running).toBe(false);
    expect(capture.isTrackLive()).toBe(false);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(node.disconnect).toHaveBeenCalledTimes(1);
  });
});
