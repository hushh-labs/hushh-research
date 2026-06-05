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
it("ignores comment heartbeat frames without dropping following events", () => {
  const input =
    ": keep-alive\n\n" +
    'event: stage\n' +
    'data: {"stage":"ready"}\n\n';

  const result = parseSSEBlocks(input);

  expect(result.remainder).toBe("");
  expect(result.events).toHaveLength(1);
  expect(result.events[0]?.event).toBe("stage");
  expect(result.events[0]?.data).toBe('{"stage":"ready"}');
});

it("ignores whitespace-only SSE separator frames", () => {
  const input =
    "\n \n\t\n\n" +
    'event: complete\n' +
    'id: 9\n' +
    'data: {"schema_version":"1.0","stream_id":"strm_ws","stream_kind":"portfolio_import","seq":9,"event":"complete","terminal":true,"payload":{"status":"ok"}}\n\n';

  const result = parseSSEBlocks(input);

  expect(result.remainder).toBe("");
  expect(result.events).toHaveLength(1);
  expect(result.events[0]).toMatchObject({
    event: "complete",
    id: "9",
  });
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
});
  });

// ── Corrupted frame sequence headers — graceful interception ──────────────────
//
// The streaming engine is a two-layer stack:
//   1. SSE wire layer  — parseSSEBlocks: splits raw text into ParsedSSEFrame objects
//   2. Envelope layer  — isKaiStreamEnvelope: validates the JSON body structure
//
// Boundary contracts under test:
//   A. The SSE layer never throws and never drops a subsequent valid frame
//      regardless of how corrupted the current frame's data or id header is.
//   B. isKaiStreamEnvelope rejects every structural mutation of the
//      required seq / schema_version / terminal / payload fields.
//   C. A multi-frame stream with out-of-order, duplicate, or gap-skipped seq
//      numbers is parsed without crash; wire order is preserved; the envelope
//      guard correctly partitions valid vs corrupted frames.

describe("parseSSEBlocks + isKaiStreamEnvelope — corrupted frame sequence header guard", () => {
  // ── A: SSE wire layer ─────────────────────────────────────────────────────

  it("does not throw and surfaces the frame when the data field contains non-JSON garbage", () => {
    const input =
      "event: chunk\n" +
      "id: 99\n" +
      "data: {{{NOT-JSON:seq=corrupted}}}\n\n";

    expect(() => parseSSEBlocks(input)).not.toThrow();

    const result = parseSSEBlocks(input);
    expect(result.events).toHaveLength(1);
    expect(result.remainder).toBe("");

    // Application layer: safe JSON.parse + envelope guard rejects the frame
    let envelope: unknown = null;
    try { envelope = JSON.parse(result.events[0]!.data); } catch { /* expected */ }
    expect(isKaiStreamEnvelope(envelope)).toBe(false);
  });

  it("preserves a corrupted SSE id header verbatim and still validates a structurally correct envelope body", () => {
    const input =
      "event: stage\n" +
      "id: seq--CORRUPT--NaN\n" +
      'data: {"schema_version":"1.0","stream_id":"strm_cid","stream_kind":"portfolio_import","seq":5,"event":"stage","terminal":false,"payload":{"stage":"active"}}\n\n';

    expect(() => parseSSEBlocks(input)).not.toThrow();

    const result = parseSSEBlocks(input);
    expect(result.events).toHaveLength(1);
    // SSE id is carried through verbatim — the parser makes no numeric assumption
    expect(result.events[0]?.id).toBe("seq--CORRUPT--NaN");
    // The JSON envelope body itself is structurally intact
    expect(isKaiStreamEnvelope(JSON.parse(result.events[0]!.data))).toBe(true);
  });

  it("recovers and emits the subsequent valid frame after a null-byte-injected data field", () => {
    const corrupted = "event: chunk\nid: 1\ndata: \x00\x01CORRUPT\x00\n\n";
    const valid =
      "event: done\n" +
      "id: 2\n" +
      'data: {"schema_version":"1.0","stream_id":"strm_nb","stream_kind":"portfolio_import","seq":2,"event":"done","terminal":true,"payload":{"status":"ok"}}\n\n';

    expect(() => parseSSEBlocks(corrupted + valid)).not.toThrow();

    const result = parseSSEBlocks(corrupted + valid);
    // Parser emits both frames — it does not inspect data content
    expect(result.events).toHaveLength(2);
    expect(result.remainder).toBe("");
    // The second (valid) frame passes the envelope guard
    expect(isKaiStreamEnvelope(JSON.parse(result.events[1]!.data))).toBe(true);
  });

  // ── B: Envelope layer — seq field type guard ──────────────────────────────

  it("rejects an envelope where seq is null (not a number)", () => {
    expect(
      isKaiStreamEnvelope({
        schema_version: "1.0",
        stream_id: "s1",
        stream_kind: "portfolio_import",
        seq: null,
        event: "chunk",
        terminal: false,
        payload: {},
      })
    ).toBe(false);
  });

  it("rejects an envelope where seq is a stringified integer (type-coercion injection)", () => {
    expect(
      isKaiStreamEnvelope({
        schema_version: "1.0",
        stream_id: "s1",
        stream_kind: "portfolio_import",
        seq: "2",
        event: "chunk",
        terminal: false,
        payload: {},
      })
    ).toBe(false);
  });

  it("rejects an envelope where seq is absent (missing required field)", () => {
    expect(
      isKaiStreamEnvelope({
        schema_version: "1.0",
        stream_id: "s1",
        stream_kind: "portfolio_import",
        event: "chunk",
        terminal: false,
        payload: {},
      })
    ).toBe(false);
  });

  it("rejects an envelope with schema_version '2.0' (version mismatch)", () => {
    expect(
      isKaiStreamEnvelope({
        schema_version: "2.0",
        stream_id: "s1",
        stream_kind: "portfolio_import",
        seq: 1,
        event: "chunk",
        terminal: false,
        payload: {},
      })
    ).toBe(false);
  });

  it("rejects an envelope where schema_version is a number instead of the string literal '1.0'", () => {
    expect(
      isKaiStreamEnvelope({
        schema_version: 1.0,
        stream_id: "s1",
        stream_kind: "portfolio_import",
        seq: 1,
        event: "chunk",
        terminal: false,
        payload: {},
      })
    ).toBe(false);
  });

  it("rejects an envelope where terminal is the string 'true' instead of boolean true", () => {
    expect(
      isKaiStreamEnvelope({
        schema_version: "1.0",
        stream_id: "s1",
        stream_kind: "portfolio_import",
        seq: 1,
        event: "chunk",
        terminal: "true",
        payload: {},
      })
    ).toBe(false);
  });

  it("rejects an envelope where terminal is numeric 1 instead of boolean true", () => {
    expect(
      isKaiStreamEnvelope({
        schema_version: "1.0",
        stream_id: "s1",
        stream_kind: "portfolio_import",
        seq: 1,
        event: "chunk",
        terminal: 1,
        payload: {},
      })
    ).toBe(false);
  });

  it("rejects an envelope where payload is null (object-null type breach)", () => {
    expect(
      isKaiStreamEnvelope({
        schema_version: "1.0",
        stream_id: "s1",
        stream_kind: "portfolio_import",
        seq: 1,
        event: "chunk",
        terminal: false,
        payload: null,
      })
    ).toBe(false);
  });

  it("rejects an envelope where stream_id is absent", () => {
    expect(
      isKaiStreamEnvelope({
        schema_version: "1.0",
        stream_kind: "portfolio_import",
        seq: 1,
        event: "chunk",
        terminal: false,
        payload: {},
      })
    ).toBe(false);
  });

  // ── C: End-to-end multi-frame sequence integrity ──────────────────────────

  it("parses a stream with out-of-order seq numbers without crashing and preserves wire order", () => {
    const frames = [3, 1, 2]
      .map(
        (seq) =>
          `event: chunk\nid: ${seq}\ndata: {"schema_version":"1.0","stream_id":"strm_oo","stream_kind":"portfolio_import","seq":${seq},"event":"chunk","terminal":false,"payload":{"text":"frame-${seq}"}}\n\n`
      )
      .join("");

    expect(() => parseSSEBlocks(frames)).not.toThrow();

    const result = parseSSEBlocks(frames);
    expect(result.remainder).toBe("");
    expect(result.events).toHaveLength(3);

    // Wire order is preserved — parser does not reorder
    const seqs = result.events.map(
      (e) => (JSON.parse(e.data) as { seq: number }).seq
    );
    expect(seqs).toEqual([3, 1, 2]);

    // All three envelopes are structurally valid (seq is a number in each)
    for (const e of result.events) {
      expect(isKaiStreamEnvelope(JSON.parse(e.data))).toBe(true);
    }
  });

  it("parses a stream with duplicate seq numbers without crashing", () => {
    const frames = [1, 1]
      .map(
        (seq) =>
          `event: chunk\nid: ${seq}\ndata: {"schema_version":"1.0","stream_id":"strm_dup","stream_kind":"portfolio_import","seq":${seq},"event":"chunk","terminal":false,"payload":{"text":"dup"}}\n\n`
      )
      .join("");

    expect(() => parseSSEBlocks(frames)).not.toThrow();

    const result = parseSSEBlocks(frames);
    expect(result.events).toHaveLength(2);
    for (const e of result.events) {
      expect(isKaiStreamEnvelope(JSON.parse(e.data))).toBe(true);
    }
  });

  it("emits all SSE frames from a mixed stream but the envelope guard accepts only structurally valid ones", () => {
    // Three frames: valid → corrupted seq:null → valid
    const valid1 = `event: stage\nid: 1\ndata: {"schema_version":"1.0","stream_id":"strm_mix","stream_kind":"portfolio_import","seq":1,"event":"stage","terminal":false,"payload":{"stage":"start"}}\n\n`;
    const corrupted = `event: chunk\nid: 2\ndata: {"schema_version":"1.0","stream_id":"strm_mix","stream_kind":"portfolio_import","seq":null,"event":"chunk","terminal":false,"payload":{}}\n\n`;
    const valid2 = `event: done\nid: 3\ndata: {"schema_version":"1.0","stream_id":"strm_mix","stream_kind":"portfolio_import","seq":3,"event":"done","terminal":true,"payload":{"status":"complete"}}\n\n`;

    const result = parseSSEBlocks(valid1 + corrupted + valid2);
    expect(result.remainder).toBe("");
    // SSE parser emits all three frames — it does not inspect JSON content
    expect(result.events).toHaveLength(3);

    // Envelope guard partitions: 2 valid, 1 corrupted
    const accepted = result.events.filter((e) =>
      isKaiStreamEnvelope(JSON.parse(e.data))
    );
    expect(accepted).toHaveLength(2);
    expect(accepted.map((e) => e.event)).toEqual(["stage", "done"]);
  });

  it("parses a stream with seq gaps (simulating dropped frames) without crashing", () => {
    // seq jumps 1 → 5 → 10: gaps indicate dropped frames, not a parser error
    const frames = [1, 5, 10]
      .map(
        (seq) =>
          `event: chunk\nid: ${seq}\ndata: {"schema_version":"1.0","stream_id":"strm_gap","stream_kind":"portfolio_import","seq":${seq},"event":"chunk","terminal":false,"payload":{"text":"gap-${seq}"}}\n\n`
      )
      .join("");

    expect(() => parseSSEBlocks(frames)).not.toThrow();

    const result = parseSSEBlocks(frames);
    expect(result.events).toHaveLength(3);

    const seqs = result.events.map(
      (e) => (JSON.parse(e.data) as { seq: number }).seq
    );
    expect(seqs).toEqual([1, 5, 10]);
  });
});
