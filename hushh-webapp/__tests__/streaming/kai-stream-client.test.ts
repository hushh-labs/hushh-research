import { describe, expect, it, vi } from "vitest";

import { consumeCanonicalKaiStream } from "@/lib/streaming/kai-stream-client";
import type { KaiStreamEnvelope } from "@/lib/streaming/kai-stream-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnvelope(overrides: Partial<KaiStreamEnvelope> = {}): KaiStreamEnvelope {
  return {
    schema_version: "1.0",
    stream_id: "strm_test",
    stream_kind: "portfolio_import",
    seq: 1,
    event: "stage",
    terminal: false,
    payload: { stage: "processing" },
    ...overrides,
  };
}

function encodeSSEFrame(envelope: KaiStreamEnvelope): string {
  return `event: ${envelope.event}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function makeStreamResponse(...frames: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) {
        controller.enqueue(encoder.encode(frames[index++]!));
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// consumeCanonicalKaiStream
// ---------------------------------------------------------------------------

describe("consumeCanonicalKaiStream", () => {
  it("throws when the response status is not ok", async () => {
    const response = new Response(null, { status: 500 });

    await expect(consumeCanonicalKaiStream(response, vi.fn())).rejects.toThrow(
      "Stream response not OK: 500"
    );
  });

  it("throws when the response has no body", async () => {
    const response = new Response(null, { status: 200 });

    await expect(consumeCanonicalKaiStream(response, vi.fn())).rejects.toThrow(
      "No response stream available"
    );
  });

  it("invokes onEnvelope for each valid frame and resolves when a terminal event is received", async () => {
    const envelopes: KaiStreamEnvelope[] = [
      makeEnvelope({ seq: 1, terminal: false }),
      makeEnvelope({ seq: 2, terminal: true }),
    ];
    const response = makeStreamResponse(...envelopes.map(encodeSSEFrame));
    const received: KaiStreamEnvelope[] = [];

    await consumeCanonicalKaiStream(response, (env) => received.push(env));

    expect(received).toHaveLength(2);
    expect(received[0]?.seq).toBe(1);
    expect(received[1]?.terminal).toBe(true);
  });

  it("throws when a frame data field contains malformed JSON", async () => {
    const badFrame = "event: stage\ndata: {not valid json}\n\n";
    const response = makeStreamResponse(badFrame);

    await expect(consumeCanonicalKaiStream(response, vi.fn())).rejects.toThrow();
  });

  it("throws when parsed JSON does not pass the KaiStreamEnvelope type guard", async () => {
    const wrongShape = { schema_version: "2.0", event: "stage" };
    const badFrame = `event: stage\ndata: ${JSON.stringify(wrongShape)}\n\n`;
    const response = makeStreamResponse(badFrame);

    await expect(consumeCanonicalKaiStream(response, vi.fn())).rejects.toThrow(
      "Invalid stream envelope received"
    );
  });

  it("throws when the SSE frame event name mismatches the envelope event field", async () => {
    const envelope = makeEnvelope({ event: "stage" });
    const mismatchFrame = `event: chunk\ndata: ${JSON.stringify(envelope)}\n\n`;
    const response = makeStreamResponse(mismatchFrame);

    await expect(consumeCanonicalKaiStream(response, vi.fn())).rejects.toThrow(
      "SSE event mismatch between frame and envelope"
    );
  });

  it("throws when the stream ends without a terminal event and requireTerminal defaults to true", async () => {
    const response = makeStreamResponse(encodeSSEFrame(makeEnvelope({ terminal: false })));

    await expect(consumeCanonicalKaiStream(response, vi.fn())).rejects.toThrow(
      "Stream ended without terminal event"
    );
  });

  it("resolves cleanly when requireTerminal is false and no terminal event arrives", async () => {
    const response = makeStreamResponse(encodeSSEFrame(makeEnvelope({ terminal: false })));

    await expect(
      consumeCanonicalKaiStream(response, vi.fn(), { requireTerminal: false })
    ).resolves.toBeUndefined();
  });

  it("throws AbortError immediately when the abort signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = makeStreamResponse(encodeSSEFrame(makeEnvelope({ terminal: true })));

    await expect(
      consumeCanonicalKaiStream(response, vi.fn(), { signal: controller.signal })
    ).rejects.toThrow("Aborted");
  });

  it("flushes and processes a buffered frame when the stream closes without a trailing separator", async () => {
    const envelope = makeEnvelope({ event: "stage", terminal: true });
    // Omit the trailing \n\n — stream closes before the block terminator arrives.
    // consumeCanonicalKaiStream appends \n\n to force-flush the remainder buffer.
    const frameNoTerminator = `event: stage\ndata: ${JSON.stringify(envelope)}\n`;
    const response = makeStreamResponse(frameNoTerminator);
    const received: KaiStreamEnvelope[] = [];

    await consumeCanonicalKaiStream(response, (env) => received.push(env));

    expect(received).toHaveLength(1);
    expect(received[0]?.terminal).toBe(true);
  });
});