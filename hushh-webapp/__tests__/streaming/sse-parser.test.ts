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
    it("recovers valid frames after malformed SSE blocks", () => {
    const input =
      "event: broken\n" +
      "id: bad-1\n" +
      "retry: 1000\n\n" +
      ": heartbeat\n\n" +
      "data: orphan payload\n\n" +
      "event: stage\n" +
      "id: 4\n" +
      'data: {"schema_version":"1.0","stream_id":"strm_3","stream_kind":"portfolio_import","seq":4,"event":"stage","terminal":false,"payload":{"stage":"recovered"}}\n\n';

    const result = parseSSEBlocks(input);

    expect(result.remainder).toBe("");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      event: "stage",
      id: "4",
    });

    const parsed = JSON.parse(result.events[0]!.data) as unknown;
    expect(isKaiStreamEnvelope(parsed)).toBe(true);
    if (isKaiStreamEnvelope(parsed)) {
      expect(parsed.payload.stage).toBe("recovered");
    }
  });
});
