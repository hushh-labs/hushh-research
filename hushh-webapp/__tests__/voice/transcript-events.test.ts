import { describe, expect, it, vi } from "vitest";

import { BrowserSpeechAdapter } from "@/lib/voice/browser-speech-adapter";
import {
  buildSpeechContextualStrings,
  IOS_SPEECH_CONTEXTUAL_STRING_LIMIT,
} from "@/lib/voice/speech-contextual-strings";
import {
  BoundedPcmRingBuffer,
  BoundedTranscriptBuffer,
  normalizeTranscriptEvent,
} from "@/lib/voice/transcript-events";

describe("cross-platform transcript contract", () => {
  it("derives bounded short ASR hints from the generated action catalog", () => {
    const hints = buildSpeechContextualStrings();

    expect(hints.length).toBeLessThanOrEqual(IOS_SPEECH_CONTEXTUAL_STRING_LIMIT);
    expect(hints).toEqual(expect.arrayContaining(["Agent One", "Circle", "location sharing"]));
    expect(new Set(hints.map((hint) => hint.toLocaleLowerCase())).size).toBe(hints.length);
    expect(hints.every((hint) => hint.length <= 64 && hint.split(/\s+/).length <= 3)).toBe(true);
  });

  it("normalizes provider events and clamps confidence/text", () => {
    const event = normalizeTranscriptEvent({
      sessionId: "session-1",
      sequence: 2,
      kind: "final",
      text: "  hello  ",
      confidence: 4,
      provider: "test",
      onDevice: true,
    });

    expect(event).toMatchObject({
      sessionId: "session-1",
      sequence: 2,
      kind: "final",
      text: "hello",
      confidence: 1,
      provider: "test",
      onDevice: true,
    });
    expect(
      normalizeTranscriptEvent({
        sessionId: "session-1",
        sequence: -1,
        kind: "final",
        text: "no",
        provider: "test",
        onDevice: false,
      }),
    ).toBeNull();
  });

  it("keeps only a bounded in-memory event window", () => {
    const buffer = new BoundedTranscriptBuffer(2);
    const event = (sequence: number) => ({
      sessionId: "session-1",
      sequence,
      kind: "partial" as const,
      text: String(sequence),
      provider: "test",
      onDevice: true,
    });
    buffer.push(event(1));
    buffer.push(event(2));
    buffer.push(event(3));
    expect(buffer.size).toBe(2);
    expect(buffer.drain().map((item) => item.sequence)).toEqual([2, 3]);
    expect(buffer.size).toBe(0);
  });

  it("bounds PCM onset memory and releases it on drain", () => {
    const buffer = new BoundedPcmRingBuffer(4);
    buffer.push(new Float32Array([1, 2, 3]));
    buffer.push(new Float32Array([4, 5, 6]));
    expect(buffer.samples).toBe(3);
    expect(buffer.drain().map((frame) => [...frame])).toEqual([[4, 5, 6]]);
    expect(buffer.samples).toBe(0);
  });

  it("maps browser provider results into the shared shape", async () => {
    const onEvent = vi.fn();
    class RecognitionMock {
      continuous = false;
      interimResults = false;
      lang = "";
      maxAlternatives = 0;
      onend: (() => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onresult: ((event: { resultIndex: number; results: unknown[] }) => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
    }
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: RecognitionMock,
    });

    const adapter = new BrowserSpeechAdapter({ onEvent });
    const started = await adapter.start({ sessionId: "browser-1" });
    expect(started).toEqual({
      sessionId: "browser-1",
      provider: "browser_speech",
      onDevice: false,
    });
    const recognition = (adapter as unknown as { recognition: RecognitionMock }).recognition;
    recognition.onresult?.({
      resultIndex: 0,
      results: [
        { isFinal: true, 0: { transcript: "create a circle", confidence: 0.8 } },
      ],
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "browser-1",
        sequence: 1,
        kind: "final",
        text: "create a circle",
        provider: "browser_speech",
        onDevice: false,
      }),
    );
    await adapter.stop();
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "end", sessionId: "browser-1" }),
    );
  });
});
