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

// ── sanitizeRequestId — length-variance safety ────────────────────────────────
//
// sanitizeRequestId is the constant-time-equivalent validation gate for all
// inbound x-request-id header values.  It evaluates length AND charset in a
// single regex pass (SAFE_REQUEST_ID_REGEX = /^[a-zA-Z0-9_.:-]{8,128}$/) so
// neither content nor position leaks timing information across branches.
//
// Contracts under test:
//   A. Absent / null / undefined / empty inputs → null (false match, no throw).
//   B. Length below the 8-character minimum → null.
//   C. Length above the 128-character maximum → null.
//   D. Exact boundary lengths (8 and 128) → accepted and returned verbatim.
//   E. Mismatched-length pairs reject the shorter value while accepting the
//      longer one when it is within range — length determines the gate, not
//      content similarity.
//   F. getOrCreateRequestId falls back to a freshly-generated ID whenever
//      the inbound header is absent or fails sanitisation, and the generated
//      ID always satisfies the regex itself.

describe("sanitizeRequestId — length-variance safety in request-ID matching", () => {
  // ── A: absent / null / undefined / empty ─────────────────────────────────

  it("returns null for null without throwing (absent token guard)", () => {
    expect(() => sanitizeRequestId(null)).not.toThrow();
    expect(sanitizeRequestId(null)).toBeNull();
  });

  it("returns null for undefined without throwing (void token guard)", () => {
    expect(() => sanitizeRequestId(undefined)).not.toThrow();
    expect(sanitizeRequestId(undefined)).toBeNull();
  });

  it("returns null for empty string (zero-length input is never a valid match)", () => {
    expect(sanitizeRequestId("")).toBeNull();
  });

  it("returns null for whitespace-only string (trimmed to empty before comparison)", () => {
    expect(sanitizeRequestId("   ")).toBeNull();
    expect(sanitizeRequestId("\t\n\r")).toBeNull();
  });

  // ── B: below the 8-character minimum ─────────────────────────────────────

  it.each([
    ["a"],          // 1 char
    ["ab"],         // 2 chars
    ["abc-123"],    // 7 chars
    ["x".repeat(7)],
  ])('returns null for "%s" (length below minimum of 8)', (value: string) => {
    expect(sanitizeRequestId(value)).toBeNull();
  });

  // ── C: above the 128-character maximum ───────────────────────────────────

  it("returns null for a 129-character value (one above maximum)", () => {
    expect(sanitizeRequestId("a".repeat(129))).toBeNull();
  });

  it("returns null for a 256-character value (far above maximum)", () => {
    expect(sanitizeRequestId("a".repeat(256))).toBeNull();
  });

  it("returns null for a 1000-character value (extreme over-length injection)", () => {
    expect(sanitizeRequestId("z".repeat(1_000))).toBeNull();
  });

  // ── D: exact boundary lengths ─────────────────────────────────────────────

  it("accepts exactly 8 characters (minimum boundary — valid match)", () => {
    const minId = "abcde-01";        // 8 chars, all in [a-zA-Z0-9_.:-]
    expect(sanitizeRequestId(minId)).toBe(minId);
  });

  it("accepts exactly 128 characters (maximum boundary — valid match)", () => {
    const maxId = "a".repeat(128);   // 128 chars
    expect(sanitizeRequestId(maxId)).toBe(maxId);
  });

  // ── E: mismatched-length pairs ────────────────────────────────────────────

  it("rejects a 7-char ID but accepts an 8-char ID with the same prefix (length gate is strict)", () => {
    const tooShort = "req-abc";      // 7 chars
    const justRight = "req-abcd";    // 8 chars
    expect(sanitizeRequestId(tooShort)).toBeNull();
    expect(sanitizeRequestId(justRight)).toBe(justRight);
  });

  it("rejects a 129-char ID but accepts a 128-char ID with the same prefix (upper length gate)", () => {
    const atMax  = "a".repeat(128);
    const oneOver = "a".repeat(129);
    expect(sanitizeRequestId(atMax)).toBe(atMax);
    expect(sanitizeRequestId(oneOver)).toBeNull();
  });

  // ── F: getOrCreateRequestId header fallback ───────────────────────────────

  it("falls back to a freshly-generated ID when the header carries a too-short value", () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: "short" }); // 5 chars < 8
    const result = getOrCreateRequestId(headers);
    // Must not echo back the invalid "short" value.
    expect(result).not.toBe("short");
    // The generated fallback must itself satisfy the ID contract.
    expect(sanitizeRequestId(result)).toBe(result);
  });

  it("falls back to a freshly-generated ID when the header is absent", () => {
    const result = getOrCreateRequestId(new Headers());
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThanOrEqual(8);
    expect(sanitizeRequestId(result)).toBe(result);
  });

  it("createRequestId always produces an ID that passes its own sanitisation gate", () => {
    // Proves the generator and the validator are consistent: every ID the
    // system creates can pass back through sanitizeRequestId unchanged.
    const generated = createRequestId();
    expect(sanitizeRequestId(generated)).toBe(generated);
  });
});
