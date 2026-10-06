import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));

import { consumePuppyPodStream } from "@/lib/services/puppy-pod-stream";

/**
 * The browser half of real-time Puppy streaming.
 *
 * The pod writes one SSE frame per relay delta. These tests hold the stream
 * open between frames and assert that each delta reaches the panel before the
 * next arrives, so a regression to "render at the end" fails here rather than
 * as a ten-second blank bubble on a live turn.
 */
function frame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function heldStream() {
  let push!: (chunk: Uint8Array) => void;
  let end!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(chunk);
      end = () => controller.close();
    },
  });
  return { response: new Response(body), push: (chunk: Uint8Array) => push(chunk), end: () => end() };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Puppy pod stream consumer", () => {
  it("hands each token to the panel as it arrives, not at the end", async () => {
    const stream = heldStream();
    const tokens: string[] = [];
    const pending = consumePuppyPodStream({
      open: async () => stream.response,
      onToken: (text) => tokens.push(text),
    });

    stream.push(frame("token", { text: "Hello" }));
    await flush();
    expect(tokens).toEqual(["Hello"]);

    stream.push(frame("token", { text: " there" }));
    await flush();
    expect(tokens).toEqual(["Hello", " there"]);

    stream.push(frame("done", { model: "google/gemma-4-12b", modelReported: true }));
    await expect(pending).resolves.toMatchObject({ model: "google/gemma-4-12b", modelReported: true });
  });

  it("streams the thinking trail separately and never into the answer", async () => {
    const stream = heldStream();
    const tokens: string[] = [];
    const thinking: string[] = [];
    const pending = consumePuppyPodStream({
      open: async () => stream.response,
      onToken: (text) => tokens.push(text),
      onThinking: (text) => thinking.push(text),
    });

    stream.push(frame("thinking", { text: "The user asks " }));
    await flush();
    expect(thinking).toEqual(["The user asks "]);
    expect(tokens).toEqual([]);

    stream.push(frame("thinking", { text: "a sum." }));
    stream.push(frame("token", { text: "391" }));
    stream.push(frame("done", { model: "m", modelReported: false }));
    await pending;
    expect(thinking.join("")).toBe("The user asks a sum.");
    expect(tokens).toEqual(["391"]);
  });

  it("refuses a malformed thinking frame instead of rendering it", async () => {
    const stream = heldStream();
    const pending = consumePuppyPodStream({
      open: async () => stream.response,
      onToken: () => undefined,
      onThinking: () => undefined,
    });
    stream.push(frame("thinking", { text: 42 }));
    await expect(pending).rejects.toThrow("PUPPY_STREAM_INVALID");
  });
});
