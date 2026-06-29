import { describe, expect, it } from "vitest";

import { isKaiStreamEnvelope } from "@/lib/streaming/kai-stream-types";

function buildValidEnvelope(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "1.0",
    stream_id: "stream-1",
    stream_kind: "portfolio_import",
    seq: 0,
    event: "chunk",
    terminal: false,
    payload: { foo: "bar" },
    ...overrides,
  };
}

describe("isKaiStreamEnvelope", () => {
  it("accepts a well-formed envelope", () => {
    expect(isKaiStreamEnvelope(buildValidEnvelope())).toBe(true);
  });

  it("accepts envelopes with additional fields", () => {
    expect(
      isKaiStreamEnvelope(
        buildValidEnvelope({ extra_field: "ignored" }),
      ),
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isKaiStreamEnvelope(null)).toBe(false);
  });

  it("rejects unsupported schema versions", () => {
    expect(
      isKaiStreamEnvelope(
        buildValidEnvelope({ schema_version: "2.0" }),
      ),
    ).toBe(false);
  });

  it("rejects non-string stream ids", () => {
    expect(
      isKaiStreamEnvelope(
        buildValidEnvelope({ stream_id: 123 }),
      ),
    ).toBe(false);
  });

  it("rejects null payloads", () => {
    expect(
      isKaiStreamEnvelope(
        buildValidEnvelope({ payload: null }),
      ),
    ).toBe(false);
  });

  it("rejects envelopes missing required fields", () => {
    const envelope = buildValidEnvelope();

    delete envelope.event;

    expect(isKaiStreamEnvelope(envelope)).toBe(false);
  });
});