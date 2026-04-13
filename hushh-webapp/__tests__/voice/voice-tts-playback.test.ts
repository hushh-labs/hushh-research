import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const synthesizeKaiVoiceMock = vi.fn();

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    synthesizeKaiVoice: (...args: unknown[]) => synthesizeKaiVoiceMock(...args),
  },
}));

import { VoiceTtsPlaybackManager } from "@/lib/voice/voice-tts-playback";
const originalEnv = { ...process.env };

class FakeAudio {
  static instances: FakeAudio[] = [];
  static autoEnd = true;
  static rejectPlayWith: Error | null = null;

  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplay: (() => void) | null = null;
  pause = vi.fn();
  attachedMediaSource: FakeMediaSource | null = null;

  constructor(url?: string) {
    this.src = url || "";
    FakeAudio.instances.push(this);
    const attachedSource = mediaSourceUrlRegistry.get(this.src) ?? null;
    if (attachedSource) {
      this.attachedMediaSource = attachedSource;
      attachedSource.attachedAudio = this;
    }
  }

  play = vi.fn((): Promise<void> => {
    if (FakeAudio.rejectPlayWith) {
      return Promise.reject(FakeAudio.rejectPlayWith);
    }
    this.onplay?.();
    if (FakeAudio.autoEnd && !this.attachedMediaSource) {
      window.setTimeout(() => {
        this.onended?.();
      }, 0);
    }
    return Promise.resolve();
  });
}

class FakeSourceBuffer {
  updating = false;
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(event: string, handler: () => void): void {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
  }

  removeEventListener(event: string, handler: () => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  appendBuffer = vi.fn(() => {
    this.updating = true;
    window.setTimeout(() => {
      this.updating = false;
      this.listeners.get("updateend")?.forEach((handler) => handler());
    }, 0);
  });
}

class FakeMediaSource {
  static instances: FakeMediaSource[] = [];
  static isTypeSupported = vi.fn(() => true);

  readyState: "closed" | "open" | "ended" = "closed";
  attachedAudio: FakeAudio | null = null;
  readonly sourceBuffers: FakeSourceBuffer[] = [];
  private listeners = new Map<string, Set<() => void>>();

  constructor() {
    FakeMediaSource.instances.push(this);
  }

  addEventListener(event: string, handler: () => void): void {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
  }

  removeEventListener(event: string, handler: () => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  dispatchSourceOpen(): void {
    this.readyState = "open";
    this.listeners.get("sourceopen")?.forEach((handler) => handler());
  }

  addSourceBuffer = vi.fn((mimeType: string) => {
    if (!FakeMediaSource.isTypeSupported(mimeType)) {
      throw new Error("UNSUPPORTED_MIME");
    }
    const sourceBuffer = new FakeSourceBuffer();
    this.sourceBuffers.push(sourceBuffer);
    return sourceBuffer;
  });

  endOfStream = vi.fn(() => {
    this.readyState = "ended";
    window.setTimeout(() => {
      this.attachedAudio?.onended?.();
    }, 0);
  });
}

const mediaSourceUrlRegistry = new Map<string, FakeMediaSource>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("VoiceTtsPlaybackManager", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_DISABLE_VOICE_FALLBACKS;
    delete process.env.NEXT_PUBLIC_FAIL_FAST_VOICE;
    delete process.env.NEXT_PUBLIC_FORCE_REALTIME_VOICE;
    delete process.env.DISABLE_VOICE_FALLBACKS;
    delete process.env.FAIL_FAST_VOICE;
    delete process.env.FORCE_REALTIME_VOICE;
    synthesizeKaiVoiceMock.mockReset();
    FakeAudio.instances = [];
    FakeAudio.autoEnd = true;
    FakeAudio.rejectPlayWith = null;
    FakeMediaSource.instances = [];
    FakeMediaSource.isTypeSupported.mockClear();
    mediaSourceUrlRegistry.clear();
    delete (globalThis as typeof globalThis & { MediaSource?: typeof MediaSource }).MediaSource;
    if ("MediaSource" in window) {
      delete (window as typeof window & { MediaSource?: typeof MediaSource }).MediaSource;
    }
    globalThis.Audio = FakeAudio as unknown as typeof Audio;
    URL.createObjectURL = vi.fn(() => "blob:voice-test");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("plays backend TTS and transitions state", async () => {
    const states: string[] = [];
    const manager = new VoiceTtsPlaybackManager((state) => states.push(state));

    synthesizeKaiVoiceMock.mockResolvedValue(
      new Response(new Uint8Array([97, 98, 99]), {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "X-Kai-TTS-Model": "gpt-4o-mini-tts",
          "X-Kai-TTS-Voice": "alloy",
          "X-Kai-TTS-Format": "mp3",
          "X-Kai-TTS-Audio-Bytes": "3",
        },
      })
    );

    await manager.speak({
      userId: "user_1",
      vaultOwnerToken: "token_1",
      text: "Hello world",
      voiceTurnId: "vturn_test_1",
    });

    expect(synthesizeKaiVoiceMock).toHaveBeenCalledTimes(1);
    expect(synthesizeKaiVoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceTurnId: "vturn_test_1",
      })
    );
    expect(states).toEqual(["loading", "playing", "idle"]);
  });

  it("starts backend playback from a stream-backed source when MediaSource is supported", async () => {
    const states: string[] = [];
    const manager = new VoiceTtsPlaybackManager((state) => states.push(state));
    const secondChunk = deferred<ReadableStreamReadResult<Uint8Array>>();
    let capturedSignal: AbortSignal | undefined;
    let readCount = 0;

    const response = new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "X-Kai-TTS-Model": "gpt-4o-mini-tts",
        "X-Kai-TTS-Voice": "alloy",
        "X-Kai-TTS-Format": "mp3",
        "X-Kai-TTS-Audio-Bytes": "6",
      },
    }) as Response & {
      body: { getReader: () => { read: () => Promise<ReadableStreamReadResult<Uint8Array>> } };
    };

    Object.defineProperty(response, "body", {
      configurable: true,
      value: {
        getReader: () => ({
          read: () => {
            readCount += 1;
            if (readCount === 1) {
              return Promise.resolve({
                done: false,
                value: new Uint8Array([97, 98, 99]),
              });
            }
            if (readCount === 2) {
              if (capturedSignal?.aborted) {
                return Promise.reject(new Error("AbortError"));
              }
              capturedSignal?.addEventListener(
                "abort",
                () => secondChunk.reject(new Error("AbortError")),
                { once: true }
              );
              return secondChunk.promise;
            }
            return Promise.resolve({ done: true, value: undefined as never });
          },
        }),
      },
    });

    synthesizeKaiVoiceMock.mockImplementation(async (args: unknown) => {
      capturedSignal = (args as { signal?: AbortSignal }).signal;
      return response;
    });

    const createdUrls: string[] = [];
    URL.createObjectURL = vi.fn((value: Blob | MediaSource) => {
      if (value instanceof FakeMediaSource) {
        const url = `blob:media-source-${createdUrls.length + 1}`;
        createdUrls.push(url);
        mediaSourceUrlRegistry.set(url, value);
        window.setTimeout(() => value.dispatchSourceOpen(), 0);
        return url;
      }
      return "blob:voice-test";
    });

    (globalThis as typeof globalThis & { MediaSource?: typeof MediaSource }).MediaSource =
      FakeMediaSource as unknown as typeof MediaSource;
    (window as typeof window & { MediaSource?: typeof MediaSource }).MediaSource =
      FakeMediaSource as unknown as typeof MediaSource;

    const speakPromise = manager.speak({
      userId: "user_1",
      vaultOwnerToken: "token_1",
      text: "Streamed hello",
      voiceTurnId: "vturn_streamed_tts",
    });

    await new Promise<void>((resolve, reject) => {
      const startedAt = performance.now();
      const poll = () => {
        if (FakeAudio.instances[0]?.play.mock.calls.length) {
          resolve();
          return;
        }
        if (performance.now() - startedAt > 1000) {
          reject(new Error("Timed out waiting for stream-backed playback to start"));
          return;
        }
        window.setTimeout(poll, 0);
      };
      poll();
    });

    expect(createdUrls).toHaveLength(1);
    expect(FakeAudio.instances[0]?.play).toHaveBeenCalledTimes(1);
    expect(states).toContain("playing");

    secondChunk.resolve({
      done: false,
      value: new Uint8Array([100, 101, 102]),
    });

    await expect(speakPromise).resolves.toBeUndefined();
    expect(states).toEqual(["loading", "playing", "idle"]);
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(FakeMediaSource));
  });

  it("stop() interrupts active playback without hanging the speak promise", async () => {
    const states: string[] = [];
    const manager = new VoiceTtsPlaybackManager((state) => states.push(state));
    FakeAudio.autoEnd = false;

    synthesizeKaiVoiceMock.mockResolvedValue(
      new Response(new Uint8Array([97, 98, 99]), {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "X-Kai-TTS-Model": "gpt-4o-mini-tts",
          "X-Kai-TTS-Voice": "alloy",
          "X-Kai-TTS-Format": "mp3",
          "X-Kai-TTS-Audio-Bytes": "3",
        },
      })
    );

    const speakPromise = manager.speak({
      userId: "user_1",
      vaultOwnerToken: "token_1",
      text: "Long response",
    });

    await Promise.resolve();
    manager.stop();

    await expect(speakPromise).resolves.toBeUndefined();
    if (FakeAudio.instances.length > 0) {
      expect(FakeAudio.instances[0]!.pause).toHaveBeenCalledTimes(1);
    }
    expect(states[states.length - 1]).toBe("idle");
  });

  it("does not use browser speech synthesis fallback when fail-fast voice is enabled", async () => {
    process.env.NEXT_PUBLIC_FAIL_FAST_VOICE = "true";
    const speechSynthesisSpeak = vi.fn();
    const speechSynthesisCancel = vi.fn();
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak: speechSynthesisSpeak,
        cancel: speechSynthesisCancel,
      },
    });

    const playbackFailures: string[] = [];
    const manager = new VoiceTtsPlaybackManager(undefined, {
      onPlaybackFailed: ({ reason }) => playbackFailures.push(reason),
    });

    synthesizeKaiVoiceMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "VOICE_TTS_HTTP_502" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      manager.speak({
        userId: "user_1",
        vaultOwnerToken: "token_1",
        text: "Hello world",
        voiceTurnId: "vturn_fail_fast_tts",
      })
    ).rejects.toThrow("VOICE_TTS_HTTP_502");

    expect(speechSynthesisSpeak).not.toHaveBeenCalled();
    expect(playbackFailures).toContain("VOICE_TTS_HTTP_502");
  });

  it("does not use browser speech synthesis fallback when force realtime voice is enabled", async () => {
    process.env.NEXT_PUBLIC_FORCE_REALTIME_VOICE = "true";
    const speechSynthesisSpeak = vi.fn();
    const speechSynthesisCancel = vi.fn();
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak: speechSynthesisSpeak,
        cancel: speechSynthesisCancel,
      },
    });

    const playbackFailures: string[] = [];
    const manager = new VoiceTtsPlaybackManager(undefined, {
      onPlaybackFailed: ({ reason }) => playbackFailures.push(reason),
    });

    synthesizeKaiVoiceMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "VOICE_TTS_HTTP_502" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      manager.speak({
        userId: "user_1",
        vaultOwnerToken: "token_1",
        text: "Hello world",
        voiceTurnId: "vturn_force_realtime_tts",
      })
    ).rejects.toThrow("VOICE_TTS_HTTP_502");

    expect(speechSynthesisSpeak).not.toHaveBeenCalled();
    expect(playbackFailures).toContain("VOICE_TTS_HTTP_502");
  });

  it("does not use browser speech synthesis fallback even when fail-fast flags are off", async () => {
    const speechSynthesisSpeak = vi.fn();
    const speechSynthesisCancel = vi.fn();
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak: speechSynthesisSpeak,
        cancel: speechSynthesisCancel,
      },
    });

    const playbackFailures: string[] = [];
    const manager = new VoiceTtsPlaybackManager(undefined, {
      onPlaybackFailed: ({ reason }) => playbackFailures.push(reason),
    });

    synthesizeKaiVoiceMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "VOICE_TTS_HTTP_502" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      manager.speak({
        userId: "user_1",
        vaultOwnerToken: "token_1",
        text: "Hello world",
        voiceTurnId: "vturn_no_browser_fallback",
      })
    ).rejects.toThrow("VOICE_TTS_HTTP_502");

    expect(speechSynthesisSpeak).not.toHaveBeenCalled();
    expect(playbackFailures).toContain("VOICE_TTS_HTTP_502");
  });

  it("falls back from realtime stream TTS to backend TTS when enabled", async () => {
    process.env.NEXT_PUBLIC_VOICE_V2_TTS_BACKEND_FALLBACK_ENABLED = "true";
    const states: string[] = [];
    const manager = new VoiceTtsPlaybackManager((state) => states.push(state));
    const realtimeSpeak = vi.fn().mockRejectedValue(new Error("VOICE_STREAM_TTS_PLAYBACK_FAILED"));

    synthesizeKaiVoiceMock.mockResolvedValue(
      new Response(new Uint8Array([97, 98, 99]), {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "X-Kai-TTS-Model": "gpt-4o-mini-tts",
          "X-Kai-TTS-Voice": "alloy",
          "X-Kai-TTS-Format": "mp3",
          "X-Kai-TTS-Audio-Bytes": "3",
        },
      })
    );

    await manager.speak({
      userId: "user_1",
      vaultOwnerToken: "token_1",
      text: "Hello world",
      voiceTurnId: "vturn_realtime_fallback",
      adapter: "realtime_stream_tts",
      realtimeAdapter: {
        speak: realtimeSpeak,
      },
    });

    expect(realtimeSpeak).toHaveBeenCalledTimes(1);
    expect(synthesizeKaiVoiceMock).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["loading", "idle", "loading", "playing", "idle"]);
  });

  it("rejects realtime stream TTS when playback never starts and fallback is disabled", async () => {
    const manager = new VoiceTtsPlaybackManager();

    await expect(
      manager.speak({
        userId: "user_1",
        vaultOwnerToken: "token_1",
        text: "Hello world",
        voiceTurnId: "vturn_realtime_no_play",
        adapter: "realtime_stream_tts",
        realtimeAdapter: {
          speak: async () => undefined,
        },
      })
    ).rejects.toThrow("VOICE_STREAM_TTS_PLAYBACK_NOT_STARTED");

    expect(synthesizeKaiVoiceMock).not.toHaveBeenCalled();
  });
});
