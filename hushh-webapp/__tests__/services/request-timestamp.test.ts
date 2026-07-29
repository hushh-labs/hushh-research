import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_CLOCK_DRIFT_MS,
  FUTURE_TIMESTAMP_ERROR,
  INVALID_TIMESTAMP_ERROR,
  REQUEST_ID_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  createRequestId,
  getOrCreateRequestId,
  getOrCreateRequestTimestampMs,
  sanitizeRequestId,
  validateHeaderTimestampConstraints,
} from "@/lib/observability/request-id";

describe("request timestamp metadata", () => {
  const runtimeClockMs = Date.parse("2026-05-23T10:30:00.000Z");

  it("accepts request timestamps within the future clock drift window", () => {
    const result = validateHeaderTimestampConstraints(
      runtimeClockMs + DEFAULT_MAX_CLOCK_DRIFT_MS,
      { nowMs: runtimeClockMs }
    );

    expect(result).toEqual({
      isSyncBlockAccepted: true,
      errorLabel: null,
    });
  });

  it("rejects request timestamps beyond the future clock drift window", () => {
    const result = validateHeaderTimestampConstraints(
      runtimeClockMs + DEFAULT_MAX_CLOCK_DRIFT_MS + 1,
      { nowMs: runtimeClockMs }
    );

    expect(result).toEqual({
      isSyncBlockAccepted: false,
      errorLabel: FUTURE_TIMESTAMP_ERROR,
    });
  });

  it("rejects malformed timestamp values", () => {
    const result = validateHeaderTimestampConstraints(Number.NaN, {
      nowMs: runtimeClockMs,
    });

    expect(result).toEqual({
      isSyncBlockAccepted: false,
      errorLabel: INVALID_TIMESTAMP_ERROR,
    });
  });

  it("normalizes future-dated request header values back to runtime time", () => {
    const headers = {
      [REQUEST_TIMESTAMP_HEADER]: String(
        runtimeClockMs + DEFAULT_MAX_CLOCK_DRIFT_MS + 1
      ),
    };

    expect(getOrCreateRequestTimestampMs(headers, runtimeClockMs)).toBe(
      runtimeClockMs
    );
  });
});

// ── Timestamp drift — anomaly detection coverage ──────────────────────────────

describe("validateHeaderTimestampConstraints — drift anomaly scenarios", () => {
  const NOW = Date.parse("2026-05-23T10:30:00.000Z");

  // ── Non-finite input guard ────────────────────────────────────────────────

  it("flags Infinity as an invalid timestamp (non-finite drift anomaly)", () => {
    const result = validateHeaderTimestampConstraints(Infinity, { nowMs: NOW });

    expect(result.isSyncBlockAccepted).toBe(false);
    expect(result.errorLabel).toBe(INVALID_TIMESTAMP_ERROR);
  });

  it("flags -Infinity as an invalid timestamp (non-finite drift anomaly)", () => {
    const result = validateHeaderTimestampConstraints(-Infinity, { nowMs: NOW });

    expect(result.isSyncBlockAccepted).toBe(false);
    expect(result.errorLabel).toBe(INVALID_TIMESTAMP_ERROR);
  });

  // ── Future drift — exact boundary and beyond ─────────────────────────────

  it("accepts a timestamp exactly one millisecond before the drift ceiling", () => {
    const result = validateHeaderTimestampConstraints(
      NOW + DEFAULT_MAX_CLOCK_DRIFT_MS - 1,
      { nowMs: NOW },
    );

    expect(result.isSyncBlockAccepted).toBe(true);
    expect(result.errorLabel).toBeNull();
  });

  it("flags a timestamp one millisecond beyond the drift ceiling as a future anomaly", () => {
    const result = validateHeaderTimestampConstraints(
      NOW + DEFAULT_MAX_CLOCK_DRIFT_MS + 1,
      { nowMs: NOW },
    );

    expect(result.isSyncBlockAccepted).toBe(false);
    expect(result.errorLabel).toBe(FUTURE_TIMESTAMP_ERROR);
  });

  it("flags a severely skewed far-future timestamp (synthetic clock runaway)", () => {
    // Simulate a client whose clock is 24 hours ahead — clear runaway drift.
    const clockRunaway = NOW + 24 * 60 * 60 * 1_000;
    const result = validateHeaderTimestampConstraints(clockRunaway, {
      nowMs: NOW,
    });

    expect(result.isSyncBlockAccepted).toBe(false);
    expect(result.errorLabel).toBe(FUTURE_TIMESTAMP_ERROR);
  });

  // ── Custom drift window ───────────────────────────────────────────────────

  it("enforces a tighter custom drift window supplied by the caller", () => {
    const tightWindowMs = 5_000; // 5 s instead of the default 60 s

    // 10 s ahead — clears the default window but violates the tight window.
    const skewed = NOW + 10_000;

    const tight = validateHeaderTimestampConstraints(skewed, {
      nowMs: NOW,
      maxClockDriftMs: tightWindowMs,
    });
    expect(tight.isSyncBlockAccepted).toBe(false);
    expect(tight.errorLabel).toBe(FUTURE_TIMESTAMP_ERROR);

    // Same skew with the default window passes.
    const defaultWindow = validateHeaderTimestampConstraints(skewed, {
      nowMs: NOW,
    });
    expect(defaultWindow.isSyncBlockAccepted).toBe(true);
  });

  it("enforces a zero-tolerance drift window (any future timestamp is rejected)", () => {
    const zeroTolerance = validateHeaderTimestampConstraints(NOW + 1, {
      nowMs: NOW,
      maxClockDriftMs: 0,
    });

    expect(zeroTolerance.isSyncBlockAccepted).toBe(false);
    expect(zeroTolerance.errorLabel).toBe(FUTURE_TIMESTAMP_ERROR);

    // Exactly nowMs passes under zero-tolerance (not strictly in the future).
    const exact = validateHeaderTimestampConstraints(NOW, {
      nowMs: NOW,
      maxClockDriftMs: 0,
    });
    expect(exact.isSyncBlockAccepted).toBe(true);
  });

  // ── Past timestamp behaviour (documents intentional design) ──────────────

  it("accepts past timestamps — the guard targets future drift only", () => {
    // One second in the past: compliant because there is no backward-drift gate.
    const pastByOne = validateHeaderTimestampConstraints(NOW - 1_000, {
      nowMs: NOW,
    });
    expect(pastByOne.isSyncBlockAccepted).toBe(true);
    expect(pastByOne.errorLabel).toBeNull();

    // Unix epoch (maximum backward skew) — still accepted by design.
    const epoch = validateHeaderTimestampConstraints(0, { nowMs: NOW });
    expect(epoch.isSyncBlockAccepted).toBe(true);
    expect(epoch.errorLabel).toBeNull();
  });
});

// ── getOrCreateRequestTimestampMs — header extraction and fallback ────────────

describe("getOrCreateRequestTimestampMs — drift-safe header parsing", () => {
  const NOW = Date.parse("2026-05-23T10:30:00.000Z");

  it("returns the parsed timestamp when the header carries a compliant value", () => {
    // 10 s in the past — well inside the accepted range.
    const validTs = NOW - 10_000;
    const headers = { [REQUEST_TIMESTAMP_HEADER]: String(validTs) };

    expect(getOrCreateRequestTimestampMs(headers, NOW)).toBe(validTs);
  });

  it("falls back to runtime clock when no timestamp header is present", () => {
    expect(getOrCreateRequestTimestampMs({}, NOW)).toBe(NOW);
    expect(getOrCreateRequestTimestampMs(null, NOW)).toBe(NOW);
    expect(getOrCreateRequestTimestampMs(undefined, NOW)).toBe(NOW);
  });

  it("falls back to runtime clock when the header value is not a valid number", () => {
    const headers = { [REQUEST_TIMESTAMP_HEADER]: "not-a-timestamp" };

    expect(getOrCreateRequestTimestampMs(headers, NOW)).toBe(NOW);
  });

  it("falls back to runtime clock when the header carries a drifted future value", () => {
    // More than DEFAULT_MAX_CLOCK_DRIFT_MS ahead → rejected → nowMs returned.
    const skewed = NOW + DEFAULT_MAX_CLOCK_DRIFT_MS + 5_000;
    const headers = { [REQUEST_TIMESTAMP_HEADER]: String(skewed) };

    expect(getOrCreateRequestTimestampMs(headers, NOW)).toBe(NOW);
  });

  it("parses the header from a Headers object (native fetch API format)", () => {
    const validTs = NOW - 500;
    const headers = new Headers({
      [REQUEST_TIMESTAMP_HEADER]: String(validTs),
    });

    expect(getOrCreateRequestTimestampMs(headers, NOW)).toBe(validTs);
  });

  it("parses the header from an array-of-tuples format", () => {
    const validTs = NOW - 1_000;
    const headers: [string, string][] = [
      [REQUEST_TIMESTAMP_HEADER, String(validTs)],
    ];

    expect(getOrCreateRequestTimestampMs(headers, NOW)).toBe(validTs);
  });
});
// ── End drift anomaly coverage ────────────────────────────────────────────────

// ── High-frequency rate-limiting fallback — request tracking header guard ─────
//
// Under burst / high-frequency load the middleware's request-ID tracking layer
// must:
//   1. Generate a unique, non-colliding fallback ID for every request arriving
//      without a pre-assigned x-request-id header.
//   2. Propagate a valid inbound ID verbatim across all concurrent calls.
//   3. Reject every structurally-invalid or oversized ID without throwing.
//   4. Produce a well-formed fallback timestamp for every request whose
//      x-request-timestamp-ms header is absent, malformed, or future-skewed,
//      with no shared state leaked between calls.
//
// Production module: lib/observability/request-id.ts

describe("high-frequency rate-limiting fallback — request tracking header guard", () => {
  const BURST = 50;

  // ── getOrCreateRequestId: burst uniqueness guarantee ─────────────────────

  it("generates a unique tracking ID for each of 50 rapid requests arriving with no x-request-id header", () => {
    const ids = Array.from({ length: BURST }, () =>
      getOrCreateRequestId(new Headers())
    );

    expect(new Set(ids).size).toBe(BURST);
    for (const id of ids) {
      expect(id).toMatch(/^[a-zA-Z0-9_.:-]{8,128}$/);
    }
  });

  it("propagates the valid inbound ID unchanged across 50 rapid requests carrying the same x-request-id", () => {
    const canonical = "req-burst-canonical-id-001";
    const headers = new Headers({ [REQUEST_ID_HEADER]: canonical });

    const ids = Array.from({ length: BURST }, () =>
      getOrCreateRequestId(headers)
    );

    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(canonical);
  });

  it("falls back to a fresh valid ID for every burst request carrying a malformed x-request-id, never throwing", () => {
    const malformed = [
      "has spaces inside",
      "id/with/slashes",  // slash is not in [a-zA-Z0-9_.:-]
      "a".repeat(7),      // too short (< 8 chars)
      "z".repeat(200),    // too long (> 128 chars)
      "!!@##$$%%",
    ];

    for (const bad of malformed) {
      const headers = new Headers({ [REQUEST_ID_HEADER]: bad });
      expect(() => getOrCreateRequestId(headers)).not.toThrow();
      const generated = getOrCreateRequestId(headers);
      expect(generated).toMatch(/^[a-zA-Z0-9_.:-]{8,128}$/);
      // Must not echo the malformed value back
      expect(generated).not.toBe(bad);
    }
  });

  // ── sanitizeRequestId: burst rejection without throwing ───────────────────

  it("returns null for every ID in a high-frequency burst of structurally-invalid values without throwing", () => {
    const invalid: Array<string | null | undefined> = [
      ...Array.from({ length: 15 }, () => ""),
      ...Array.from({ length: 15 }, () => null),
      ...Array.from({ length: 8 }, (_, i) => "x".repeat(i)), // 0..7 chars, all below the 8-char minimum
      "!@#$%^&*()",
      "has spaces",
      "\t\n\r",
    ];

    for (const v of invalid) {
      expect(() => sanitizeRequestId(v)).not.toThrow();
      expect(sanitizeRequestId(v)).toBeNull();
    }
  });

  it("accepts every ID in a burst of structurally-valid request IDs at boundary lengths", () => {
    const valid = [
      "req-12345678",
      "a".repeat(8),    // exactly at minimum length
      "z".repeat(128),  // exactly at maximum length
      "550e8400-e29b-41d4-a716-446655440000",
      "req_1234567890_abcdefgh",
      "X-ReQ:id.001-TRACE",
      "REQ:001.PROD",
    ];

    for (const v of valid) {
      expect(sanitizeRequestId(v)).toBe(v.trim());
    }
  });

  // ── createRequestId: burst collision resistance ───────────────────────────

  it("produces 50 collision-free tracking IDs under rapid-fire createRequestId calls", () => {
    const ids = Array.from({ length: BURST }, () => createRequestId());

    expect(new Set(ids).size).toBe(BURST);
    for (const id of ids) {
      expect(id).toMatch(/^[a-zA-Z0-9_.:-]{8,128}$/);
    }
  });

  // ── getOrCreateRequestTimestampMs: burst fallback integrity ───────────────

  it("falls back to the runtime clock for every request in a 50-call burst with no timestamp header", () => {
    const NOW = Date.parse("2026-05-23T10:30:00.000Z");

    const results = Array.from({ length: BURST }, () =>
      getOrCreateRequestTimestampMs(new Headers(), NOW)
    );

    for (const ts of results) {
      expect(ts).toBe(NOW);
    }
  });

  it("falls back to runtime clock for every burst request carrying an invalid timestamp value, never throwing", () => {
    const NOW = Date.parse("2026-05-23T10:30:00.000Z");
    const invalids = [
      "not-a-number",
      "",            // empty string is falsy → parsed as NaN → fallback
      "NaN",
      "Infinity",
      "-Infinity",
      "true",
      "undefined",
      "9".repeat(25), // overflows beyond drift window → future anomaly → fallback
    ];

    for (const tsValue of invalids) {
      const headers = new Headers({ [REQUEST_TIMESTAMP_HEADER]: tsValue });
      expect(() => getOrCreateRequestTimestampMs(headers, NOW)).not.toThrow();
      expect(getOrCreateRequestTimestampMs(headers, NOW)).toBe(NOW);
    }
  });

  it("computes unique per-request fallback timestamps for a burst of future-skewed headers with no shared-state leak", () => {
    const BASE_NOW = Date.parse("2026-05-23T10:30:00.000Z");

    const results = Array.from({ length: 20 }, (_, i) => {
      const futureTs = BASE_NOW + DEFAULT_MAX_CLOCK_DRIFT_MS + (i + 1) * 1_000;
      const headers = new Headers({
        [REQUEST_TIMESTAMP_HEADER]: String(futureTs),
      });
      const nowMs = BASE_NOW + i;
      return { nowMs, ts: getOrCreateRequestTimestampMs(headers, nowMs) };
    });

    // Every fallback must equal the nowMs supplied for that specific call
    for (const { nowMs, ts } of results) {
      expect(ts).toBe(nowMs);
    }
  });
});
