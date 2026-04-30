import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useVoiceDictation } from "@/lib/voice/use-voice-dictation";

type SpeechRecognitionHandlers = {
  onstart: (() => void) | null;
  onresult: ((event: { results: Array<Array<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

class MockSpeechRecognition implements SpeechRecognitionHandlers {
  static instances: MockSpeechRecognition[] = [];
  static throwOnStart = false;

  lang = "";
  interimResults = true;
  maxAlternatives = 0;
  continuous = true;
  onstart: (() => void) | null = null;
  onresult: ((event: { results: Array<Array<{ transcript: string }>> }) => void) | null =
    null;
  onerror: (() => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => {
    if (MockSpeechRecognition.throwOnStart) {
      throw new Error("speech permission denied");
    }
    this.onstart?.();
  });
  stop = vi.fn(() => {
    this.onend?.();
  });

  constructor() {
    MockSpeechRecognition.instances.push(this);
  }

  emitResult(transcript: string) {
    this.onresult?.({ results: [[{ transcript }]] });
  }
}

describe("useVoiceDictation", () => {
  const speechWindow = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  const originalSpeechRecognition = speechWindow.SpeechRecognition;
  const originalWebkitSpeechRecognition = speechWindow.webkitSpeechRecognition;

  beforeEach(() => {
    MockSpeechRecognition.instances = [];
    MockSpeechRecognition.throwOnStart = false;
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: MockSpeechRecognition,
    });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: originalSpeechRecognition,
    });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      value: originalWebkitSpeechRecognition,
    });
  });

  it("writes the final speech transcript through the caller callback", () => {
    const onResult = vi.fn();
    const { result } = renderHook(() => useVoiceDictation({ onResult }));

    act(() => {
      result.current.start();
    });

    expect(result.current.status).toBe("listening");
    expect(MockSpeechRecognition.instances[0]?.lang).toBe("en-US");

    act(() => {
      MockSpeechRecognition.instances[0]?.emitResult("  show my dashboard  ");
    });

    expect(onResult).toHaveBeenCalledWith("show my dashboard");
    expect(result.current.status).toBe("idle");
  });

  it("fails closed when the browser speech engine cannot start", () => {
    const onResult = vi.fn();
    MockSpeechRecognition.throwOnStart = true;
    const { result } = renderHook(() => useVoiceDictation({ onResult }));

    act(() => {
      expect(() => result.current.start()).not.toThrow();
    });

    expect(onResult).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  it("reports unsupported without constructing a recognizer", () => {
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      value: undefined,
    });
    const { result } = renderHook(() => useVoiceDictation({ onResult: vi.fn() }));

    act(() => {
      result.current.start();
    });

    expect(result.current.supported).toBe(false);
    expect(result.current.status).toBe("unsupported");
    expect(MockSpeechRecognition.instances).toHaveLength(0);
  });

  it("stops active recognition on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useVoiceDictation({ onResult: vi.fn(), lang: "en-IN" })
    );

    act(() => {
      result.current.start();
    });

    const recognizer = MockSpeechRecognition.instances[0];
    expect(recognizer?.lang).toBe("en-IN");

    unmount();

    expect(recognizer?.stop).toHaveBeenCalled();
  });
});
