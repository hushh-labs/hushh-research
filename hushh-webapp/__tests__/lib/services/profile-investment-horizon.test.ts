/**
 * Characterization suite — @/lib/services/kai-profile-service
 *
 * Pins the PUBLIC scoring contract for investment-horizon handling. The goal is
 * to lock down how the exported risk-scoring surface behaves when it is fed an
 * unrecognized / extreme / malformed horizon value, so future refactors cannot
 * silently change the fallback shape.
 *
 * IMPORTANT (verified against source, not assumed):
 *   - `normalizeInvestmentHorizon` is module-private and is NOT exported, so it
 *     cannot be imported directly. The sanctioned public surface is the
 *     `score*` helpers plus `computeRiskScore` / `mapRiskProfile`.
 *   - `scoreInvestmentHorizon` does NOT collapse unknown strings to null. By the
 *     implementation it returns 0 for "short_term", 1 for "medium_term", and 2
 *     for *anything else that is truthy* (the final `return 2`). It returns null
 *     only for falsy input (null / "" / undefined).
 *   - `computeRiskScore` returns null only when one of the three component
 *     scores is null (i.e. a falsy preference), never by throwing.
 *
 * These tests therefore characterize the real, shipped behavior: the scoring
 * surface is total (never throws) and degrades to deterministic values, and the
 * only path to a null risk score is a missing (falsy) preference.
 */

import { describe, it, expect } from "vitest";

import {
  scoreInvestmentHorizon,
  computeRiskScore,
  mapRiskProfile,
} from "@/lib/services/kai-profile-service";

// Casts are intentional: we are deliberately probing out-of-contract inputs to
// characterize runtime safety, which TypeScript would otherwise forbid.
const asHorizon = (value: unknown) =>
  value as Parameters<typeof scoreInvestmentHorizon>[0];

describe("kai-profile-service · investment horizon scoring (public contract)", () => {
  it("scores the three known horizons deterministically", () => {
    expect(scoreInvestmentHorizon("short_term")).toBe(0);
    expect(scoreInvestmentHorizon("medium_term")).toBe(1);
    expect(scoreInvestmentHorizon("long_term")).toBe(2);
  });

  it("returns null for falsy horizons (null / empty / undefined) without throwing", () => {
    expect(scoreInvestmentHorizon(null)).toBeNull();
    expect(() => scoreInvestmentHorizon(asHorizon(""))).not.toThrow();
    expect(scoreInvestmentHorizon(asHorizon(""))).toBeNull();
    expect(() => scoreInvestmentHorizon(asHorizon(undefined))).not.toThrow();
    expect(scoreInvestmentHorizon(asHorizon(undefined))).toBeNull();
  });

  it("does not throw on unrecognized / extreme horizon strings and degrades to the 'long' bucket (2)", () => {
    const extremeInputs = [
      "ultra_long_term",
      "SHORT_TERM",
      "forever",
      "🚀",
      "a".repeat(10_000),
      "0",
    ];
    for (const value of extremeInputs) {
      expect(() => scoreInvestmentHorizon(asHorizon(value))).not.toThrow();
      // Any truthy-but-unknown string falls through to the final `return 2`.
      expect(scoreInvestmentHorizon(asHorizon(value))).toBe(2);
    }
  });

  it("computeRiskScore returns null when the horizon is missing, never throwing", () => {
    expect(
      computeRiskScore({
        investment_horizon: null,
        drawdown_response: "stay",
        volatility_preference: "moderate",
      })
    ).toBeNull();
  });

  it("computeRiskScore tolerates an extreme horizon and still produces a mappable numeric score", () => {
    const score = computeRiskScore({
      investment_horizon: asHorizon("ultra_long_term"),
      drawdown_response: "stay",
      volatility_preference: "moderate",
    });
    // 2 (unknown horizon bucket) + 1 (stay) + 1 (moderate) = 4
    expect(score).toBe(4);
    expect(score).not.toBeNull();
    expect(mapRiskProfile(score as number)).toBe("balanced");
  });
});
