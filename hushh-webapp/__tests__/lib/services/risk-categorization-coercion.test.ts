import { describe, it, expect } from "vitest";

import {
  scoreInvestmentHorizon,
  scoreDrawdownResponse,
  scoreVolatilityPreference,
  computeRiskScore,
  mapRiskProfile,
  type RiskProfile,
} from "@/lib/services/kai-profile-service";

/**
 * Characterization tests for the public risk-categorization processing surface
 * of KaiProfileService when fed risk text variants (unexpected casing, mixed /
 * padded spaces).
 *
 * IMPORTANT TRUTH CORRECTION
 * --------------------------
 * The premise that this surface "normalizes unexpected casing or mixed spaces
 * into expected constants" is NOT how the code behaves today.
 *
 * Verified source: hushh-webapp/lib/services/kai-profile-service.ts
 *   - scoreInvestmentHorizon / scoreDrawdownResponse / scoreVolatilityPreference
 *     compare with STRICT `===` against canonical lowercase tokens
 *     ("short_term", "reduce", "small", ...). There is NO toLowerCase(),
 *     NO trim(), NO whitespace collapsing.
 *   - Each function guards falsy inputs (`if (!value) return null`) and
 *     otherwise FALLS THROUGH to the maximum ordinal (`return 2`) for ANY
 *     unrecognized truthy value, including a mis-cased or space-padded token.
 *   - The exported `normalize*` helpers that do strict matching are module-
 *     private and are not part of the public surface.
 *
 * Consequence pinned below: casing / spacing variants are NOT coerced back to
 * their intended canonical category. They are silently treated as "unknown
 * truthy" and bucket into the fallthrough score 2, which then maps via
 * mapRiskProfile() into a deterministic-but-misleading structural constant.
 *
 * These tests pin that ACTUAL behavior so any future hardening (adding real
 * case/space normalization) is a visible, reviewed change rather than silent.
 */

const CANONICAL: ReadonlyArray<RiskProfile> = ["conservative", "balanced", "aggressive"];

describe("Risk categorization coercion — public processing surface", () => {
  describe("exact canonical tokens map to their intended ordinal scores", () => {
    it("scores investment horizon precisely for canonical lowercase tokens", () => {
      expect(scoreInvestmentHorizon("short_term")).toBe(0);
      expect(scoreInvestmentHorizon("medium_term")).toBe(1);
      expect(scoreInvestmentHorizon("long_term")).toBe(2);
    });

    it("scores drawdown response precisely for canonical lowercase tokens", () => {
      expect(scoreDrawdownResponse("reduce")).toBe(0);
      expect(scoreDrawdownResponse("stay")).toBe(1);
      expect(scoreDrawdownResponse("buy_more")).toBe(2);
    });

    it("scores volatility preference precisely for canonical lowercase tokens", () => {
      expect(scoreVolatilityPreference("small")).toBe(0);
      expect(scoreVolatilityPreference("moderate")).toBe(1);
      expect(scoreVolatilityPreference("large")).toBe(2);
    });
  });

  describe("casing variants are NOT normalized (strict ===)", () => {
    it("treats upper/mixed-case horizon tokens as unknown -> fallthrough score 2", () => {
      // "SHORT_TERM" should ideally map to 0 if casing were normalized; it does not.
      expect(scoreInvestmentHorizon("SHORT_TERM" as never)).toBe(2);
      expect(scoreInvestmentHorizon("Short_Term" as never)).toBe(2);
      expect(scoreInvestmentHorizon("Medium_Term" as never)).toBe(2);
    });

    it("treats upper/mixed-case drawdown tokens as unknown -> fallthrough score 2", () => {
      expect(scoreDrawdownResponse("REDUCE" as never)).toBe(2);
      expect(scoreDrawdownResponse("Stay" as never)).toBe(2);
    });

    it("treats upper/mixed-case volatility tokens as unknown -> fallthrough score 2", () => {
      expect(scoreVolatilityPreference("SMALL" as never)).toBe(2);
      expect(scoreVolatilityPreference("Moderate" as never)).toBe(2);
    });
  });

  describe("whitespace / mixed-space variants are NOT normalized", () => {
    it("treats padded or internally-spaced horizon tokens as unknown -> 2", () => {
      expect(scoreInvestmentHorizon(" short_term " as never)).toBe(2);
      expect(scoreInvestmentHorizon("short term" as never)).toBe(2);
      expect(scoreInvestmentHorizon("short__term" as never)).toBe(2);
    });

    it("treats padded drawdown / volatility tokens as unknown -> 2", () => {
      expect(scoreDrawdownResponse(" reduce" as never)).toBe(2);
      expect(scoreVolatilityPreference("small " as never)).toBe(2);
    });

    it("still guards genuinely empty / falsy inputs back to null", () => {
      // Empty string is falsy => the `if (!value)` guard returns null, NOT 2.
      expect(scoreInvestmentHorizon("" as never)).toBeNull();
      expect(scoreDrawdownResponse("" as never)).toBeNull();
      expect(scoreVolatilityPreference("" as never)).toBeNull();
      // A purely whitespace string is truthy and is NOT trimmed => fallthrough 2.
      expect(scoreInvestmentHorizon("   " as never)).toBe(2);
    });
  });

  describe("end-to-end: variant inputs coerce into a stable structural constant", () => {
    it("maps a fully canonical conservative profile deterministically", () => {
      const score = computeRiskScore({
        investment_horizon: "short_term",
        drawdown_response: "reduce",
        volatility_preference: "small",
      });
      expect(score).toBe(0);
      expect(mapRiskProfile(score as number)).toBe("conservative");
    });

    it("coerces an all-variant (mis-cased / spaced) payload into the aggressive constant", () => {
      // Because every variant falls through to 2, the sum is 6 => "aggressive".
      // This documents that bad casing/spacing does NOT degrade to null or throw;
      // it silently produces the maximum-risk structural constant.
      const score = computeRiskScore({
        investment_horizon: "SHORT_TERM" as never,
        drawdown_response: " reduce" as never,
        volatility_preference: "Small" as never,
      });
      expect(score).toBe(6);
      const profile = mapRiskProfile(score as number);
      expect(profile).toBe("aggressive");
      expect(CANONICAL).toContain(profile);
    });

    it("returns null only when a field is genuinely empty/falsy", () => {
      const score = computeRiskScore({
        investment_horizon: "" as never,
        drawdown_response: "reduce",
        volatility_preference: "small",
      });
      expect(score).toBeNull();
    });
  });
});
