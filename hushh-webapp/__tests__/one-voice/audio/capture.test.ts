import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveAudioCapture, probeMicrophone } from "@/lib/one-voice/audio/capture";

afterEach(() => vi.unstubAllGlobals());

describe("LiveAudioCapture microphone ownership", () => {
  it("cancels a probe before late permission and immediately releases a pending worklet's resources", async () => {
    const stop = vi.fn();
    const stream = { getAudioTracks: () => [], getTracks: () => [{ stop }] } as unknown as MediaStream;
    let grant!: (stream: MediaStream) => void;
    const late = new AbortController();
    const contextCreated = vi.fn();
    class Context {
      constructor() { contextCreated(); }
      close = async () => undefined;
    }
    const pendingPermission = probeMicrophone({
      signal: late.signal,
      getUserMedia: () => new Promise(resolve => { grant = resolve; }),
      AudioContextImpl: Context as unknown as typeof AudioContext,
    });
    late.abort();
    grant(stream);
    expect((await pendingPermission).ok).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(contextCreated).not.toHaveBeenCalled();

    let finishWorklet!: () => void;
    let startedWorklet!: () => void;
    const workletStarted = new Promise<void>(resolve => { startedWorklet = resolve; });
    const close = vi.fn(async () => undefined);
    class LoadingContext {
      sampleRate = 48_000;
      close = close;
      audioWorklet = { addModule: () => { startedWorklet(); return new Promise<void>(resolve => { finishWorklet = resolve; }); } };
    }
    const loading = new AbortController();
    const pendingWorklet = probeMicrophone({
      signal: loading.signal,
      getUserMedia: async () => stream,
      AudioContextImpl: LoadingContext as unknown as typeof AudioContext,
    });
    await workletStarted;
    loading.abort();
    // No worklet completion is needed to stop the actual microphone.
    expect(stop).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    finishWorklet();
    expect((await pendingWorklet).ok).toBe(false);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

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
