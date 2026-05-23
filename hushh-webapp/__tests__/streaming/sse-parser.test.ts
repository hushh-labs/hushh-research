import { describe, expect, it } from "vitest";

import { MAX_FRAME_BYTES, parseSSEBlocks } from "@/lib/streaming/sse-parser";
import { isKaiStreamEnvelope } from "@/lib/streaming/kai-stream-types";

describe("parseSSEBlocks", () => {
  it("parses canonical single event frames", () => {
    const input =
      'event: stage\n' +
      'id: 1\n' +
      'data: {"schema_version":"1.0","stream_id":"strm_1","stream_kind":"portfolio_import","seq":1,"event":"stage","terminal":false,"payload":{"stage":"uploading"}}\n\n';

    const result = parseSSEBlocks(input);
    expect(result.remainder).toBe("");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.event).toBe("stage");
    expect(result.events[0]?.id).toBe("1");

    const parsed = JSON.parse(result.events[0]!.data) as unknown;
    expect(isKaiStreamEnvelope(parsed)).toBe(true);
    if (isKaiStreamEnvelope(parsed)) {
      expect(parsed.payload.stage).toBe("uploading");
    }
  });

  it("supports multiline data payload reassembly", () => {
    const input =
      'event: chunk\n' +
      'id: 2\n' +
      'data: {"schema_version":"1.0","stream_id":"strm_1",\n' +
      'data: "stream_kind":"portfolio_import","seq":2,"event":"chunk","terminal":false,"payload":{"text":"line1\\nline2"}}\n\n';

    const result = parseSSEBlocks(input);
    expect(result.events).toHaveLength(1);

    const parsed = JSON.parse(result.events[0]!.data) as unknown;
    expect(isKaiStreamEnvelope(parsed)).toBe(true);
    if (isKaiStreamEnvelope(parsed)) {
      expect(parsed.event).toBe("chunk");
      expect(parsed.payload.text).toContain("line1");
    }
  });

  it("preserves incomplete frame as remainder", () => {
    const part1 =
      'event: stage\n' +
      'id: 3\n' +
      'data: {"schema_version":"1.0","stream_id":"strm_2","stream_kind":"portfolio_optimize","seq":3,"event":"stage","terminal":false,"payload":{"stage":"thinking"}}';

    const first = parseSSEBlocks(part1);
    expect(first.events).toHaveLength(0);
    expect(first.remainder).toContain("event: stage");

    const second = parseSSEBlocks("\n\n", first.remainder);
    expect(second.events).toHaveLength(1);
    expect(second.remainder).toBe("");
  });

  it("ignores blocks without event and data", () => {
    const result = parseSSEBlocks(": ping\n\n\n");
    expect(result.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseSSEBlocks — MAX_FRAME_BYTES size guard (CWE-400)
// ---------------------------------------------------------------------------

describe("parseSSEBlocks — MAX_FRAME_BYTES size guard", () => {
  it("throws when frame data exceeds MAX_FRAME_BYTES", () => {
    const oversizeData = "x".repeat(MAX_FRAME_BYTES + 1);
    const input = `event: stage\nid: 1\ndata: ${oversizeData}\n\n`;
    expect(() => parseSSEBlocks(input)).toThrow(/exceeds maximum allowed size/i);
  });

  it("does not throw for a normal-sized production envelope", () => {
    const input =
      "event: stage\n" +
      "id: 99\n" +
      'data: {"schema_version":"1.0","stream_id":"strm_prod","stream_kind":"portfolio_import","seq":99,"event":"stage","terminal":false,"payload":{"stage":"complete"}}\n\n';
    expect(() => parseSSEBlocks(input)).not.toThrow();
  });

  it("throws only on the oversized frame, not subsequent frames", () => {
    const oversizeData = "y".repeat(MAX_FRAME_BYTES + 100);
    const badFrame = `event: stage\nid: 1\ndata: ${oversizeData}\n\n`;
    const goodFrame =
      "event: stage\nid: 2\n" +
      'data: {"schema_version":"1.0","stream_id":"s","stream_kind":"portfolio_import","seq":2,"event":"stage","terminal":false,"payload":{}}\n\n';
    expect(() => parseSSEBlocks(badFrame + goodFrame)).toThrow(/exceeds maximum allowed size/i);
  });
});
