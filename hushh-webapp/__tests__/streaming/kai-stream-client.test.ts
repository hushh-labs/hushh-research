import { describe, expect, it } from "vitest";

import { consumeCanonicalKaiStream } from "@/lib/streaming/kai-stream-client";
import type { KaiStreamEnvelope } from "@/lib/streaming/kai-stream-types";

function envelope(event: string, seq: number, terminal = false): KaiStreamEnvelope {
  return {
    schema_version: "1.0",
    stream_id: "strm_test",
    stream_kind: "stock_analyze",
    seq,
    event,
    terminal,
    payload: {
      phase: event,
      progress_pct: terminal ? 100 : 1,
      stream_id: "strm_test",
    },
  };
}

function frame(event: string, seq: number, terminal = false): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\nid: ${seq}\ndata: ${JSON.stringify(
      envelope(event, seq, terminal)
    )}\n\n`
  );
}

describe("consumeCanonicalKaiStream", () => {
  it("allows active streams to exceed the idle window when chunks keep arriving", async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(frame("agent_start", 1));
        await new Promise((resolve) => setTimeout(resolve, 15));
        controller.enqueue(frame("agent_token", 2));
        await new Promise((resolve) => setTimeout(resolve, 15));
        controller.enqueue(frame("decision", 3, true));
        controller.close();
      },
    });

    const events: string[] = [];
    await consumeCanonicalKaiStream(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      (item) => events.push(item.event),
      { idleTimeoutMs: 40 }
    );

    expect(events).toEqual(["agent_start", "agent_token", "decision"]);
  });

  it("fails while reader.read is pending when no chunk arrives before idle timeout", async () => {
    const body = new ReadableStream<Uint8Array>({
      start() {
        // Keep the stream open and silent.
      },
    });

    await expect(
      consumeCanonicalKaiStream(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
        () => undefined,
        { idleTimeoutMs: 10 }
      )
    ).rejects.toThrow("Stream timeout - no data received");
  });
});
