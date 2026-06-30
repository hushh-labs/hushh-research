/**
 * Characterization suite — @/lib/services/kai-profile-service · computeRiskScore
 *
 * Pins how the exported risk-score calculation responds to "empty"-shaped
 * inputs: null/undefined preference fields, empty object structures, and
 * unexpected empty arrays.
 *
 * TRUTH-FIRST NOTE (verified against source, not assumed):
 *   computeRiskScore delegates to three per-field scorers, each guarded by
 *   `if (!value) return null`. computeRiskScore then returns null if ANY of the
 *   three sub-scores is null, else the numeric sum. Concretely:
 *
 *     - null / undefined field      -> falsy -> sub-score null -> total null
 *     - missing field (empty object) -> undefined -> sub-score null -> total null
 *     - empty array []               -> TRUTHY -> bypasses the null guard and
 *                                       falls through to the final `return 2`
 *                                       (it is not a known enum value, so it
 *                                       lands on the catch-all branch). This is
 *                                       the surprising boundary worth pinning.
 *     - whole `preferences` = null   -> throws (no top-level guard); property
 *                                       access on null is a TypeError.
 *
 *   These tests pin the ACTUAL contract. They do not assert a "should",
 *   they document what ships today so a future refactor changes it visibly.
 */

import { describe, it, expect } from "vitest";

import { computeRiskScore } from "@/lib/services/kai-profile-service";

// Loose alias for feeding deliberately off-contract values into a typed param.
const compute = computeRiskScore as unknown as (input: unknown) => number | null;

describe("kai-profile-service · computeRiskScore under empty/null inputs (public contract)", () => {
  it("returns null when every preference field is explicitly null", () => {
    expect(
      computeRiskScore({
        investment_horizon: null,
        drawdown_response: null,
        volatility_preference: null,
      })
    ).toBeNull();
  });

  it("returns null for an entirely empty object (all fields missing/undefined)", () => {
    expect(compute({})).toBeNull();
  });

  it("returns null if even a single field is null while others are valid", () => {
    expect(
      computeRiskScore({
        investment_horizon: "long_term",
        drawdown_response: "buy_more",
        volatility_preference: null,
      })
    ).toBeNull();
  });

  it("does NOT collapse empty arrays to null — they are truthy and fall through to the catch-all score of 2 each (total 6)", () => {
    // Pins the surprising boundary: [] bypasses `if (!value)` and lands on the
    // final `return 2` in each scorer, summing to 6.
    expect(
      compute({
        investment_horizon: [],
        drawdown_response: [],
        volatility_preference: [],
      })
    ).toBe(6);
  });

  it("throws when the whole preferences object is null (no top-level guard)", () => {
    expect(() => compute(null)).toThrow();
  });

  it("computes the additive sum for fully-valid lowest-risk inputs (sanity anchor: 0)", () => {
    expect(
      computeRiskScore({
        investment_horizon: "short_term",
        drawdown_response: "reduce",
        volatility_preference: "small",
      })
    ).toBe(0);
  });
});
