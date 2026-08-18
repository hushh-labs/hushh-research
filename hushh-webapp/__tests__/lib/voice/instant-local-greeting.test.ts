import { afterEach, describe, expect, it, vi } from "vitest";

import {
  playInstantLocalGreeting,
  stopInstantLocalGreeting,
} from "@/lib/voice/instant-local-greeting";

function stubSpeechSynthesis() {
  const speak = vi.fn();
  const cancel = vi.fn();
  const synthesis = {
    speak,
    cancel,
    speaking: false,
    pending: false,
  };
  vi.stubGlobal("speechSynthesis", synthesis);
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    vi.fn(function (this: { text: string; rate: number }, text: string) {
      this.text = text;
      this.rate = 1;
    }),
  );
  return synthesis;
}

describe("playInstantLocalGreeting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("speaks immediately via the device's own text-to-speech, synchronously", () => {
    const synthesis = stubSpeechSynthesis();

    playInstantLocalGreeting();

    // No await, no microtask flush -- this must be synchronous or it is not
    // actually instant.
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(synthesis.speak).toHaveBeenCalledTimes(1);
    expect(synthesis.speak.mock.calls[0][0]).toMatchObject({
      text: expect.stringContaining("how can I help"),
    });
  });

  it("clears any pending utterance first so a rapid double-tap never queues two greetings", () => {
    const synthesis = stubSpeechSynthesis();

    playInstantLocalGreeting();
    playInstantLocalGreeting();

    expect(synthesis.cancel).toHaveBeenCalledTimes(2);
    expect(synthesis.speak).toHaveBeenCalledTimes(2);
  });

  it("does nothing and never throws when the browser has no speechSynthesis", () => {
    vi.stubGlobal("speechSynthesis", undefined);

    expect(() => playInstantLocalGreeting()).not.toThrow();
  });

  it("swallows a speak() failure rather than breaking voice startup", () => {
    const synthesis = stubSpeechSynthesis();
    synthesis.speak.mockImplementation(() => {
      throw new Error("boom");
    });

    expect(() => playInstantLocalGreeting()).not.toThrow();
  });
});

describe("stopInstantLocalGreeting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cancels an in-progress greeting", () => {
    const synthesis = stubSpeechSynthesis();
    synthesis.speaking = true;

    stopInstantLocalGreeting();

    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a still-pending (not yet started) greeting too", () => {
    const synthesis = stubSpeechSynthesis();
    synthesis.pending = true;

    stopInstantLocalGreeting();

    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when nothing is speaking or pending", () => {
    const synthesis = stubSpeechSynthesis();

    stopInstantLocalGreeting();

    expect(synthesis.cancel).not.toHaveBeenCalled();
  });

  it("never throws when the browser has no speechSynthesis", () => {
    vi.stubGlobal("speechSynthesis", undefined);

    expect(() => stopInstantLocalGreeting()).not.toThrow();
  });
});
