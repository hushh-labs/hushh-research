import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentTtsQueue,
  extractCompleteSpeechChunks,
  markdownToSpeechText,
} from "@/lib/agent/agent-voice-tts";

describe("agent voice TTS", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("cleans Markdown before speech synthesis", () => {
    expect(
      markdownToSpeechText(
        "## Nvidia analysis\n\n- **Revenue** grew. See [details](https://example.com). `NVDA`"
      )
    ).toBe("Nvidia analysis Revenue grew. See details. NVDA");
  });

  it("extracts sentence chunks and keeps partial text buffered", () => {
    const result = extractCompleteSpeechChunks(
      "Starting Nvidia analysis. Waiting for Kai to open the page"
    );

    expect(result.chunks).toEqual(["Starting Nvidia analysis."]);
    expect(result.remainder).toBe("Waiting for Kai to open the page");
  });

  it("queues TTS per completed sentence from streamed Markdown snapshots", async () => {
    const synthesize = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(new Blob(["audio"], { type: "audio/wav" }), {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        })
      )
    );
    const playAudio = vi.fn().mockResolvedValue(undefined);
    const queue = new AgentTtsQueue({
      userId: "user-1",
      vaultOwnerToken: "vault-token",
      synthesize,
      playAudio,
    });

    queue.pushMarkdownSnapshot("Starting **Nvidia** analysis.");
    queue.pushMarkdownSnapshot("Starting **Nvidia** analysis. Opening the Analysis page");
    queue.flushStream();
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(playAudio).toHaveBeenCalledTimes(2));

    expect(synthesize.mock.calls.map(([input]) => input.text)).toEqual([
      "Starting Nvidia analysis.",
      "Opening the Analysis page",
    ]);
  });

  it("emits an early chunk for long speech without punctuation", () => {
    const longText =
      "This voice response is intentionally long and does not include a sentence boundary yet because Gemini can stream a useful explanation before punctuation arrives in the chat";

    const result = extractCompleteSpeechChunks(longText);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].length).toBeGreaterThan(40);
    expect(result.remainder.length).toBeGreaterThan(0);
  });

  it("retries transient TTS synthesis failures", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(new Blob(["audio"], { type: "audio/wav" }), {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        })
      );
    const playAudio = vi.fn().mockResolvedValue(undefined);
    const queue = new AgentTtsQueue({
      userId: "user-1",
      vaultOwnerToken: "vault-token",
      synthesize,
      playAudio,
      maxAttempts: 2,
    });

    queue.speakNow("Retry this sentence.");

    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(playAudio).toHaveBeenCalledTimes(1));
  });

  it("reports pending speech while a chunk is queued or playing", async () => {
    let resolveSynthesize: (() => void) | null = null;
    const synthesize = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveSynthesize = () =>
            resolve(
              new Response(new Blob(["audio"], { type: "audio/wav" }), {
                status: 200,
                headers: { "Content-Type": "audio/wav" },
              })
            );
        })
    );
    const playAudio = vi.fn().mockResolvedValue(undefined);
    const queue = new AgentTtsQueue({
      userId: "user-1",
      vaultOwnerToken: "vault-token",
      synthesize,
      playAudio,
    });

    queue.speakNow("Keep the mic paused until this finishes.");

    expect(queue.hasPendingSpeech).toBe(true);
    resolveSynthesize?.();
    await vi.waitFor(() => expect(playAudio).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(queue.hasPendingSpeech).toBe(false));
  });

  it("uses browser speech fallback when backend TTS does not return audio", async () => {
    const synthesize = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    const playAudio = vi.fn().mockResolvedValue(undefined);
    const fallbackSpeak = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const queue = new AgentTtsQueue({
      userId: "user-1",
      vaultOwnerToken: "vault-token",
      synthesize,
      playAudio,
      fallbackSpeak,
      onError,
      maxAttempts: 1,
    });

    queue.speakNow("Fallback sentence.");

    await vi.waitFor(() => expect(fallbackSpeak).toHaveBeenCalledTimes(1));

    expect(playAudio).not.toHaveBeenCalled();
    expect(fallbackSpeak).toHaveBeenCalledWith("Fallback sentence.", expect.any(AbortSignal));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "synthesize",
        status: 503,
      })
    );
  });

  it("times out browser speech fallback so voice capture can resume", async () => {
    vi.useFakeTimers();
    const synthesize = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    const playAudio = vi.fn().mockResolvedValue(undefined);
    const speak = vi.fn();
    const cancel = vi.fn();
    const onError = vi.fn();
    class MockSpeechSynthesisUtterance {
      text: string;
      onend: (() => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;

      constructor(text: string) {
        this.text = text;
      }
    }
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { speak, cancel },
    });
    vi.stubGlobal("SpeechSynthesisUtterance", MockSpeechSynthesisUtterance);
    const queue = new AgentTtsQueue({
      userId: "user-1",
      vaultOwnerToken: "vault-token",
      synthesize,
      playAudio,
      onError,
      maxAttempts: 1,
    });

    queue.speakNow("Fallback speech that never reaches onend.");

    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(31_000);

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "fallback",
          message: "Browser speech synthesis timed out.",
        })
      )
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(queue.hasPendingSpeech).toBe(false));
  });

  it("aborts current TTS work on cancel", async () => {
    let aborted = false;
    const synthesize = vi.fn(
      ({ signal }) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    );
    const queue = new AgentTtsQueue({
      userId: "user-1",
      vaultOwnerToken: "vault-token",
      synthesize,
      playAudio: vi.fn(),
    });

    queue.speakNow("This is a long spoken response.");
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));
    queue.cancel();

    expect(aborted).toBe(true);
  });
});
