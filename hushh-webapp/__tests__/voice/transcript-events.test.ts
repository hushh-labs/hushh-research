import { describe, expect, it } from "vitest";

import {
  BoundedPcmRingBuffer,
  BoundedTranscriptBuffer,
  normalizeTranscriptEvent,
} from "@/lib/voice/transcript-events";

describe("cross-platform transcript contract", () => {
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

});
