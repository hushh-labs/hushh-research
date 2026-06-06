import { describe, expect, it } from "vitest";

import {
  MINIMUM_RETRY_DELAY_MS,
  RETRY_DELAY_CONSTRAINT_ERROR,
  enforceMinimumRetryDelayMs,
  evaluateRetryIntervalConstraint,
} from "@/lib/runtime/retry-delay";

describe("retry delay constraints", () => {
  it("accepts elapsed retry intervals at the minimum boundary", () => {
    const initialExecutionTime = 1_716_500_000_000;
    const result = evaluateRetryIntervalConstraint(
      initialExecutionTime,
      initialExecutionTime + MINIMUM_RETRY_DELAY_MS
    );

    expect(result).toEqual({
      isDelayGateCompliant: true,
      elapsedMs: MINIMUM_RETRY_DELAY_MS,
      errorLabel: null,
    });
  });

  it("rejects rapid-fire retry intervals below the minimum boundary", () => {
    const initialExecutionTime = 1_716_500_000_000;
    const result = evaluateRetryIntervalConstraint(
      initialExecutionTime,
      initialExecutionTime + 50
    );

    expect(result).toEqual({
      isDelayGateCompliant: false,
      elapsedMs: 50,
      errorLabel: RETRY_DELAY_CONSTRAINT_ERROR,
    });
  });

  it("normalizes configured retry delays before runtime scheduling uses them", () => {
    expect(enforceMinimumRetryDelayMs(750)).toBe(MINIMUM_RETRY_DELAY_MS);
    expect(enforceMinimumRetryDelayMs(2000)).toBe(2000);
    expect(enforceMinimumRetryDelayMs(Number.NaN)).toBe(
      MINIMUM_RETRY_DELAY_MS
    );
  });
});

// ── Failure-scenario and floor-enforcement coverage ───────────────────────────

describe("retry delay — failure simulation and mandatory floor threshold", () => {
  const T0 = 1_716_500_000_000; // fixed epoch anchor for deterministic tests

  // ── evaluateRetryIntervalConstraint ──────────────────────────────────────

  it("rejects an immediate retry (0 ms elapsed) — worst-case flood scenario", () => {
    const result = evaluateRetryIntervalConstraint(T0, T0);

    expect(result.isDelayGateCompliant).toBe(false);
    expect(result.elapsedMs).toBe(0);
    expect(result.errorLabel).toBe(RETRY_DELAY_CONSTRAINT_ERROR);
  });

  it("accepts an elapsed interval strictly above the minimum floor", () => {
    const result = evaluateRetryIntervalConstraint(
      T0,
      T0 + MINIMUM_RETRY_DELAY_MS + 1,
    );

    expect(result.isDelayGateCompliant).toBe(true);
    expect(result.elapsedMs).toBe(MINIMUM_RETRY_DELAY_MS + 1);
    expect(result.errorLabel).toBeNull();
  });

  it("enforces a custom minimum floor supplied by the caller", () => {
    const customFloorMs = 5_000;

    // 3 s gap: clears the default floor (1 s) but violates the custom floor (5 s)
    const belowCustom = evaluateRetryIntervalConstraint(
      T0,
      T0 + 3_000,
      customFloorMs,
    );
    expect(belowCustom.isDelayGateCompliant).toBe(false);
    expect(belowCustom.errorLabel).toBe(RETRY_DELAY_CONSTRAINT_ERROR);

    // 6 s gap: clears the custom floor
    const aboveCustom = evaluateRetryIntervalConstraint(
      T0,
      T0 + 6_000,
      customFloorMs,
    );
    expect(aboveCustom.isDelayGateCompliant).toBe(true);
    expect(aboveCustom.errorLabel).toBeNull();
  });

  it("correctly computes elapsedMs for arbitrary timestamp pairs", () => {
    const gap = 3_750;
    const result = evaluateRetryIntervalConstraint(T0, T0 + gap);

    expect(result.elapsedMs).toBe(gap);
  });

  // ── enforceMinimumRetryDelayMs — floor clamping ──────────────────────────

  it("clamps zero to the minimum floor", () => {
    expect(enforceMinimumRetryDelayMs(0)).toBe(MINIMUM_RETRY_DELAY_MS);
  });

  it("clamps negative values to the minimum floor", () => {
    expect(enforceMinimumRetryDelayMs(-1)).toBe(MINIMUM_RETRY_DELAY_MS);
    expect(enforceMinimumRetryDelayMs(-99_999)).toBe(MINIMUM_RETRY_DELAY_MS);
  });

  it("preserves the minimum floor value itself unchanged", () => {
    expect(enforceMinimumRetryDelayMs(MINIMUM_RETRY_DELAY_MS)).toBe(
      MINIMUM_RETRY_DELAY_MS,
    );
  });

  it("preserves values above the floor unchanged", () => {
    expect(enforceMinimumRetryDelayMs(MINIMUM_RETRY_DELAY_MS + 1)).toBe(
      MINIMUM_RETRY_DELAY_MS + 1,
    );
    expect(enforceMinimumRetryDelayMs(30_000)).toBe(30_000);
  });

  it("clamps Infinity to the minimum floor (non-finite input guard)", () => {
    expect(enforceMinimumRetryDelayMs(Infinity)).toBe(MINIMUM_RETRY_DELAY_MS);
    expect(enforceMinimumRetryDelayMs(-Infinity)).toBe(MINIMUM_RETRY_DELAY_MS);
  });

  it("respects a custom floor parameter for all clamping decisions", () => {
    const customFloor = 3_000;

    // below custom floor → clamped
    expect(enforceMinimumRetryDelayMs(1_000, customFloor)).toBe(customFloor);
    expect(enforceMinimumRetryDelayMs(0, customFloor)).toBe(customFloor);
    expect(enforceMinimumRetryDelayMs(NaN, customFloor)).toBe(customFloor);

    // above custom floor → preserved
    expect(enforceMinimumRetryDelayMs(5_000, customFloor)).toBe(5_000);
  });

  it("returned delay is always >= MINIMUM_RETRY_DELAY_MS (floor invariant)", () => {
    const inputs = [
      -1, 0, 1, 500, MINIMUM_RETRY_DELAY_MS - 1, MINIMUM_RETRY_DELAY_MS,
      MINIMUM_RETRY_DELAY_MS + 1, 5_000, 30_000, NaN, Infinity, -Infinity,
    ];
    for (const v of inputs) {
      expect(enforceMinimumRetryDelayMs(v)).toBeGreaterThanOrEqual(
        MINIMUM_RETRY_DELAY_MS,
      );
    }
  });
});
// ── End failure-scenario and floor-enforcement coverage ───────────────────────
