import { describe, expect, it } from "vitest";

import { parseSSEBlocks } from "@/lib/streaming/sse-parser";
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

describe("parseSSEBlocks – malformed frame and continuation recovery", () => {
  it("normalizes CRLF line endings before parsing", () => {
    const crlfChunk =
      "event: stage\r\n" +
      "id: 10\r\n" +
      'data: {"schema_version":"1.0","stream_id":"strm_crlf","stream_kind":"portfolio_import","seq":10,"event":"stage","terminal":false,"payload":{"stage":"done"}}\r\n\r\n';

    const result = parseSSEBlocks(crlfChunk);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.event).toBe("stage");
    expect(result.events[0]?.id).toBe("10");
    expect(result.remainder).toBe("");
  });

  it("parses two complete event blocks from a single chunk", () => {
    const makeBlock = (seq: number, event: string): string =>
      `event: ${event}\nid: ${seq}\n` +
      `data: {"schema_version":"1.0","stream_id":"strm_multi","stream_kind":"stock_analyze","seq":${seq},"event":"${event}","terminal":false,"payload":{}}\n\n`;

    const result = parseSSEBlocks(makeBlock(1, "stage") + makeBlock(2, "chunk"));

    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.event).toBe("stage");
    expect(result.events[1]?.event).toBe("chunk");
    expect(result.remainder).toBe("");
  });

  it("ignores a block that has an event line but no data line", () => {
    const result = parseSSEBlocks("event: stage\nid: 5\n\n");

    expect(result.events).toHaveLength(0);
    expect(result.remainder).toBe("");
  });

  it("ignores a block that has a data line but no event line", () => {
    const result = parseSSEBlocks(
      'data: {"schema_version":"1.0","stream_id":"s","stream_kind":"portfolio_import","seq":1,"event":"stage","terminal":false,"payload":{}}\n\n'
    );

    expect(result.events).toHaveLength(0);
  });

  it("produces no events and clears remainder for a whitespace-only chunk", () => {
    const result = parseSSEBlocks("   \n\n   ");

    expect(result.events).toHaveLength(0);
    expect(result.remainder.trim()).toBe("");
  });

  it("parses a frame correctly when no id line is present", () => {
    const result = parseSSEBlocks(
      "event: stage\n" +
        'data: {"schema_version":"1.0","stream_id":"strm_noid","stream_kind":"portfolio_optimize","seq":1,"event":"stage","terminal":false,"payload":{"stage":"ready"}}\n\n'
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.id).toBeUndefined();
    expect(result.events[0]?.event).toBe("stage");
  });

  it("reassembles a frame split across three consecutive chunks", () => {
    const part1 = 'event: chunk\nid: 7\ndata: {"schema_version":"1.0",';
    const part2 = '"stream_id":"strm_split","stream_kind":"stock_analyze",';
    const part3 =
      '"seq":7,"event":"chunk","terminal":false,"payload":{"text":"hi"}}\n\n';

    const r1 = parseSSEBlocks(part1);
    expect(r1.events).toHaveLength(0);

    const r2 = parseSSEBlocks(part2, r1.remainder);
    expect(r2.events).toHaveLength(0);

    const r3 = parseSSEBlocks(part3, r2.remainder);
    expect(r3.events).toHaveLength(1);
    expect(r3.events[0]?.event).toBe("chunk");
    expect(r3.remainder).toBe("");
  });

  it("joins multiple data lines with a newline character", () => {
    const result = parseSSEBlocks("event: chunk\ndata: line_a\ndata: line_b\n\n");

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.data).toBe("line_a\nline_b");
  });

  it("passes an empty chunk through without discarding the existing remainder", () => {
    const partial = "event: stage\nid: 99\ndata: partial_payload";

    const r1 = parseSSEBlocks(partial);
    expect(r1.events).toHaveLength(0);
    expect(r1.remainder).toContain("event: stage");

    const r2 = parseSSEBlocks("", r1.remainder);
    expect(r2.events).toHaveLength(0);
    expect(r2.remainder).toContain("event: stage");
  });
});
