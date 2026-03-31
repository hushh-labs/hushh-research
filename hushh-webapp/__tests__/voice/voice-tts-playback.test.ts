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

  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplay: (() => void) | null = null;
  pause = vi.fn();

  constructor(url?: string) {
    this.src = url || "";
    FakeAudio.instances.push(this);
  }

  play(): Promise<void> {
    this.onplay?.();
    if (FakeAudio.autoEnd) {
      window.setTimeout(() => {
        this.onended?.();
      }, 0);
    }
    return Promise.resolve();
  }
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
});
