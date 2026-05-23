import { describe, expect, it, vi } from "vitest";

import {
  consumeCanonicalKaiStream,
  MAX_FRAMES_PER_STREAM,
} from "@/lib/streaming/kai-stream-client";
import type { KaiStreamEnvelope } from "@/lib/streaming/kai-stream-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnvelopeSSEText(seq: number, terminal: boolean): string {
  const envelope: KaiStreamEnvelope = {
    schema_version: "1.0",
    stream_id: "strm_test",
    stream_kind: "portfolio_import",
    seq,
    event: "stage",
    terminal,
    payload: { stage: "processing" },
  };
  return `event: stage\nid: ${seq}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/**
 * Build a single Uint8Array chunk containing `count` SSE frames.
 * Batching into one chunk avoids thousands of async read() round-trips,
 * keeping frame-count tests fast without reducing coverage.
 */
function makeChunk(count: number, terminalOnLast = false): Uint8Array {
  const text = Array.from({ length: count }, (_, i) =>
    makeEnvelopeSSEText(i + 1, terminalOnLast && i === count - 1)
  ).join("");
  return new TextEncoder().encode(text);
}

function makeStreamResponse(chunks: Uint8Array[]): {
  response: Response;
  cancelSpy: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const cancelSpy = vi.fn(async () => {});
  const reader = {
    read: vi.fn(async () => {
      if (index >= chunks.length) return { done: true as const, value: undefined };
      return { done: false as const, value: chunks[index++]! };
    }),
    cancel: cancelSpy,
    releaseLock: vi.fn(),
    closed: Promise.resolve(undefined),
  };
  const response = {
    ok: true,
    status: 200,
    body: { getReader: () => reader },
  } as unknown as Response;
  return { response, cancelSpy };
}

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

describe("consumeCanonicalKaiStream — happy path", () => {
  it("delivers all envelopes to onEnvelope in order", async () => {
    const { response } = makeStreamResponse([makeChunk(3, true)]);
    const received: KaiStreamEnvelope[] = [];
    await consumeCanonicalKaiStream(response, (env) => received.push(env));
    expect(received).toHaveLength(3);
    expect(received[0]?.seq).toBe(1);
    expect(received[2]?.terminal).toBe(true);
  });

  it("resolves without error when stream ends with a terminal envelope", async () => {
    const { response } = makeStreamResponse([makeChunk(1, true)]);
    await expect(consumeCanonicalKaiStream(response, () => {})).resolves.toBeUndefined();
  });

  it("rejects a non-ok response before reading any body", async () => {
    const response = { ok: false, status: 503 } as Response;
    await expect(consumeCanonicalKaiStream(response, () => {})).rejects.toThrow("503");
  });

  it("rejects when response body is null", async () => {
    const response = { ok: true, status: 200, body: null } as unknown as Response;
    await expect(consumeCanonicalKaiStream(response, () => {})).rejects.toThrow(
      /no response stream/i
    );
  });
});

// ---------------------------------------------------------------------------
// MAX_FRAMES_PER_STREAM guard (CWE-400)
// ---------------------------------------------------------------------------

describe("consumeCanonicalKaiStream — MAX_FRAMES_PER_STREAM guard", () => {
  it("rejects when frame count exceeds MAX_FRAMES_PER_STREAM", async () => {
    // All frames arrive in one chunk — one read() call, deterministic count
    const { response, cancelSpy } = makeStreamResponse([
      makeChunk(MAX_FRAMES_PER_STREAM + 1, false),
    ]);

    await expect(
      consumeCanonicalKaiStream(response, () => {}, { requireTerminal: false })
    ).rejects.toThrow(/exceeded maximum frame count/i);

    expect(cancelSpy).toHaveBeenCalled();
  });

  it("includes MAX_FRAMES_PER_STREAM value in the thrown error message", async () => {
    const { response } = makeStreamResponse([makeChunk(MAX_FRAMES_PER_STREAM + 1, false)]);

    await expect(
      consumeCanonicalKaiStream(response, () => {}, { requireTerminal: false })
    ).rejects.toThrow(String(MAX_FRAMES_PER_STREAM));
  });

  it("accepts a stream with exactly MAX_FRAMES_PER_STREAM frames", async () => {
    const { response } = makeStreamResponse([makeChunk(MAX_FRAMES_PER_STREAM, true)]);
    const received: KaiStreamEnvelope[] = [];

    await expect(
      consumeCanonicalKaiStream(response, (env) => received.push(env))
    ).resolves.toBeUndefined();

    expect(received).toHaveLength(MAX_FRAMES_PER_STREAM);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal
// ---------------------------------------------------------------------------

describe("consumeCanonicalKaiStream — AbortSignal", () => {
  it("rejects with AbortError when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { response } = makeStreamResponse([makeChunk(1, true)]);

    await expect(
      consumeCanonicalKaiStream(response, () => {}, { signal: controller.signal })
    ).rejects.toThrow(/aborted/i);
  });
});

// ---------------------------------------------------------------------------
// terminal frame enforcement
// ---------------------------------------------------------------------------

describe("consumeCanonicalKaiStream — terminal frame enforcement", () => {
  it("rejects when requireTerminal=true (default) and no terminal frame arrives", async () => {
    const { response } = makeStreamResponse([makeChunk(2, false)]);
    await expect(consumeCanonicalKaiStream(response, () => {})).rejects.toThrow(/terminal/i);
  });

  it("resolves when requireTerminal=false and no terminal frame arrives", async () => {
    const { response } = makeStreamResponse([makeChunk(2, false)]);
    await expect(
      consumeCanonicalKaiStream(response, () => {}, { requireTerminal: false })
    ).resolves.toBeUndefined();
  });
});