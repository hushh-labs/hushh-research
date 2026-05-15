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
    it("preserves SSE event ordering across fragmented chunks", () => {
    const first =
      'event: stage\nid: 1\ndata: {"schema_version":"1.0","stream_id":"strm_order","stream_kind":"portfolio_import","seq":1,"event":"stage","terminal":false,"payload":{"stage":"one"}}\n\n' +
      'event: chunk\nid: 2\ndata: {"schema_version":"1.0","stream_id":"strm_order","stream_kind":"portfolio_import","seq":2,';

    const firstResult = parseSSEBlocks(first);

    expect(firstResult.events).toHaveLength(1);
    expect(firstResult.events[0]?.event).toBe("stage");
    expect(firstResult.remainder).toContain("event: chunk");

    const second =
      '"event":"chunk","terminal":false,"payload":{"text":"two"}}\n\n' +
      'event: done\nid: 3\ndata: {"schema_version":"1.0","stream_id":"strm_order","stream_kind":"portfolio_import","seq":3,"event":"done","terminal":true,"payload":{"status":"complete"}}\n\n';

    const secondResult = parseSSEBlocks(second, firstResult.remainder);

    expect(secondResult.remainder).toBe("");
    expect(secondResult.events.map((event) => event.id)).toEqual(["2", "3"]);
    expect(secondResult.events.map((event) => event.event)).toEqual(["chunk", "done"]);
  });
});
