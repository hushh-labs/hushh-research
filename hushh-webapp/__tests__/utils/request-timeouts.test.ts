import { afterEach, describe, expect, it } from "vitest";

import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

const ORIGINAL_APP_ENV = process.env.NEXT_PUBLIC_APP_ENV;
const ORIGINAL_RUNTIME_PROFILE = process.env.APP_RUNTIME_PROFILE;
const ORIGINAL_ENVIRONMENT = process.env.ENVIRONMENT;
const ORIGINAL_OVERRIDE = process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

describe("resolveSlowRequestTimeoutMs", () => {
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_ENV = ORIGINAL_APP_ENV;
    process.env.APP_RUNTIME_PROFILE = ORIGINAL_RUNTIME_PROFILE;
    process.env.ENVIRONMENT = ORIGINAL_ENVIRONMENT;
    process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS = ORIGINAL_OVERRIDE;
  });

  it("raises slow request timeouts for local development", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "development";
    delete process.env.APP_RUNTIME_PROFILE;
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    expect(resolveSlowRequestTimeoutMs(20_000)).toBe(75_000);
  });

  it("keeps production-like runtimes on the provided default", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.APP_RUNTIME_PROFILE;
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    expect(resolveSlowRequestTimeoutMs(20_000)).toBe(20_000);
  });

  it("lets runtime profile beat backend ENVIRONMENT for local UAT frontend", () => {
    delete process.env.NEXT_PUBLIC_APP_ENV;
    process.env.APP_RUNTIME_PROFILE = "uat";
    process.env.ENVIRONMENT = "development";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    expect(resolveSlowRequestTimeoutMs(20_000)).toBe(20_000);
  });

  it("honors explicit timeout overrides", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "development";
    process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS = "33000";

    expect(resolveSlowRequestTimeoutMs(20_000)).toBe(33_000);
  });
});

// ── Fringe-input boundary fallbacks ──────────────────────────────────────────
//
// resolveSlowRequestTimeoutMs guards the defaultMs parameter with:
//   Number.isFinite(defaultMs) && defaultMs > 0
//
// When either condition fails, the function falls back to the internal
// DEVELOPMENT_SLOW_REQUEST_TIMEOUT_MS floor (75 000 ms) rather than
// propagating 0, a negative value, or NaN to callers.  This ensures every
// code path that relies on a timeout receives a non-zero, non-NaN value
// even when the caller passes fringe or undefined input.
//
// Tests run against a non-development runtime (uat) so the result depends
// only on safeDefaultMs — no development-floor amplification obscures the
// fallback contract.

describe("resolveSlowRequestTimeoutMs — fringe-input boundary fallbacks", () => {
  const SAFE_FLOOR = 75_000; // DEVELOPMENT_SLOW_REQUEST_TIMEOUT_MS

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_ENV = ORIGINAL_APP_ENV;
    process.env.APP_RUNTIME_PROFILE = ORIGINAL_RUNTIME_PROFILE;
    process.env.ENVIRONMENT = ORIGINAL_ENVIRONMENT;
    process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS = ORIGINAL_OVERRIDE;
  });

  // ── Negative defaultMs ────────────────────────────────────────────────────

  it("falls back to the safe floor when defaultMs is a negative integer", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    // -1 fails the `defaultMs > 0` guard → safeDefaultMs = SAFE_FLOOR.
    expect(resolveSlowRequestTimeoutMs(-1)).toBe(SAFE_FLOOR);
    expect(resolveSlowRequestTimeoutMs(-5_000)).toBe(SAFE_FLOOR);
    expect(resolveSlowRequestTimeoutMs(-Infinity)).toBe(SAFE_FLOOR);
  });

  // ── Zero defaultMs ────────────────────────────────────────────────────────

  it("falls back to the safe floor when defaultMs is exactly zero (closed-posture boundary)", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    // 0 is finite but not > 0 → safeDefaultMs = SAFE_FLOOR.
    // A zero-millisecond timeout would cause immediate connection drops;
    // the guard replaces it with a meaningful minimum.
    expect(resolveSlowRequestTimeoutMs(0)).toBe(SAFE_FLOOR);
  });

  // ── NaN defaultMs ─────────────────────────────────────────────────────────

  it("falls back to the safe floor when defaultMs is NaN — no NaN escapes the function", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    // Number.isFinite(NaN) = false → safeDefaultMs = SAFE_FLOOR.
    const result = resolveSlowRequestTimeoutMs(Number.NaN);
    expect(result).toBe(SAFE_FLOOR);
    // Critical: the returned value must never be NaN.
    expect(Number.isNaN(result)).toBe(false);
    expect(Number.isFinite(result)).toBe(true);
  });

  // ── Infinity defaultMs ────────────────────────────────────────────────────

  it("falls back to the safe floor when defaultMs is positive Infinity", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    // Number.isFinite(Infinity) = false → safeDefaultMs = SAFE_FLOOR.
    const result = resolveSlowRequestTimeoutMs(Infinity);
    expect(result).toBe(SAFE_FLOOR);
    expect(Number.isFinite(result)).toBe(true);
  });

  // ── Undefined / non-numeric defaultMs ────────────────────────────────────

  it("falls back to the safe floor when defaultMs is undefined", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    // Number.isFinite(undefined) = false → safeDefaultMs = SAFE_FLOOR.
    expect(resolveSlowRequestTimeoutMs(undefined as never)).toBe(SAFE_FLOOR);
  });

  it("falls back to the safe floor when defaultMs is a non-numeric object", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    // Number.isFinite({}) = false → safeDefaultMs = SAFE_FLOOR.
    expect(resolveSlowRequestTimeoutMs({} as never)).toBe(SAFE_FLOOR);
    expect(resolveSlowRequestTimeoutMs(null as never)).toBe(SAFE_FLOOR);
  });

  // ── Fractional defaultMs rounds safely ────────────────────────────────────

  it("rounds fractional defaultMs to the nearest integer without NaN or truncation error", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    // Math.round is applied to valid finite positive fractions.
    expect(resolveSlowRequestTimeoutMs(1.4)).toBe(1);
    expect(resolveSlowRequestTimeoutMs(1.5)).toBe(2);
    expect(resolveSlowRequestTimeoutMs(20_000.9)).toBe(20_001);
    // Result is always an integer (no fractional millisecond leaks to callers).
    expect(Number.isInteger(resolveSlowRequestTimeoutMs(9_999.1))).toBe(true);
  });

  // ── Empty options object ───────────────────────────────────────────────────

  it("behaves identically whether options is omitted or passed as an empty object", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    // {} has no overrideEnvKey or developmentFloorMs — both code paths converge.
    expect(resolveSlowRequestTimeoutMs(20_000)).toBe(
      resolveSlowRequestTimeoutMs(20_000, {})
    );
  });

  // ── Zero developmentFloorMs treated as missing ────────────────────────────

  it("treats zero developmentFloorMs as absent and applies the built-in floor in development", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "development";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    // `0 || SAFE_FLOOR` evaluates to SAFE_FLOOR because 0 is falsy.
    // Math.max(20_000, SAFE_FLOOR) = SAFE_FLOOR.
    expect(resolveSlowRequestTimeoutMs(20_000, { developmentFloorMs: 0 })).toBe(
      SAFE_FLOOR
    );
  });

  // ── Negative developmentFloorMs does not undercut safeDefaultMs ───────────

  it("ignores a negative developmentFloorMs — Math.max preserves safeDefaultMs in development", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "development";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    // -5_000 is truthy so it is used as the floor argument.
    // Math.max(20_000, -5_000) = 20_000 → safeDefaultMs wins.
    expect(
      resolveSlowRequestTimeoutMs(20_000, { developmentFloorMs: -5_000 })
    ).toBe(20_000);
  });

  // ── Custom override key pointing to an unset env var ─────────────────────

  it("falls through gracefully when the custom override env var is not defined", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.MY_CUSTOM_TIMEOUT_KEY;
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    // parsePositiveInteger(undefined) → null → no override applied.
    expect(
      resolveSlowRequestTimeoutMs(20_000, { overrideEnvKey: "MY_CUSTOM_TIMEOUT_KEY" })
    ).toBe(20_000);
  });

  // ── Override env var with fringe string values ────────────────────────────

  it("ignores override env vars that contain non-positive or non-numeric strings", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";

    const fringe = ["0", "-1", "abc", "NaN", "Infinity", "", "  "];
    for (const value of fringe) {
      process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS = value;
      // parsePositiveInteger rejects all of these → falls through to safeDefaultMs.
      expect(
        resolveSlowRequestTimeoutMs(20_000),
        `override "${value}" should be ignored`
      ).toBe(20_000);
    }
  });

  it("handles Number.MAX_SAFE_INTEGER defaultMs without overflow or NaN fallback", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    const result = resolveSlowRequestTimeoutMs(Number.MAX_SAFE_INTEGER);

    expect(result).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(result)).toBe(true);
    expect(Number.isSafeInteger(result)).toBe(true);
  });

  it("rounds mid-range fractional timeout inputs to a safe integer duration", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    const result = resolveSlowRequestTimeoutMs(45.67);

    expect(result).toBe(46);
    expect(Number.isFinite(result)).toBe(true);
    expect(Number.isInteger(result)).toBe(true);
  });
});
