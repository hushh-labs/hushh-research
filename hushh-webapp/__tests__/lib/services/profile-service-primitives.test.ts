import { describe, it, expect } from "vitest";

import {
  scoreInvestmentHorizon,
  scoreDrawdownResponse,
  scoreVolatilityPreference,
  computeRiskScore,
  mapRiskProfile,
  resolveKaiOnboardingCompletion,
  isKaiOnboardingCompleted,
} from "@/lib/services/kai-profile-service";

/**
 * Characterization tests for the public, synchronous data-accepting surface of
 * KaiProfileService when fed completely unexpected raw primitive payloads
 * (standalone booleans, numerical strings, mismatched structural types).
 *
 * These tests do NOT assert what the API *should* do. They pin down the
 * currently observed behavior so future refactors surface accidental changes.
 *
 * Verified source: hushh-webapp/lib/services/kai-profile-service.ts
 *   - score*() guard with `if (!value) return null`, exact-string match the
 *     three known enum members, otherwise fall through to `return 2`.
 *   - computeRiskScore() reads three named props; missing/invalid props
 *     resolve to null and short-circuit the sum to null (no throw).
 *   - mapRiskProfile() compares numerically with `<=`, so primitive args are
 *     coerced via JS comparison semantics rather than validated.
 *   - resolveKaiOnboardingCompletion()/isKaiOnboardingCompleted() use optional
 *     chaining (`profile?.onboarding.completed`). This ONLY short-circuits on
 *     null/undefined. A non-nullish primitive (e.g. `true`) resolves
 *     `true.onboarding` to undefined and then throws a TypeError on `.completed`.
 */

describe("KaiProfileService public surface — malformed primitive payloads", () => {
  describe("scoreInvestmentHorizon", () => {
    it("returns null for falsy primitives instead of throwing", () => {
      expect(scoreInvestmentHorizon(null)).toBeNull();
      // Cast to bypass the TS enum signature: simulate raw runtime payloads.
      expect(scoreInvestmentHorizon(undefined as never)).toBeNull();
      expect(scoreInvestmentHorizon(false as never)).toBeNull();
      expect(scoreInvestmentHorizon(0 as never)).toBeNull();
      expect(scoreInvestmentHorizon("" as never)).toBeNull();
    });

    it("maps known enum members to their fixed ordinal scores", () => {
      expect(scoreInvestmentHorizon("short_term")).toBe(0);
      expect(scoreInvestmentHorizon("medium_term")).toBe(1);
      expect(scoreInvestmentHorizon("long_term")).toBe(2);
    });

    it("treats any unknown truthy primitive as the fallthrough score 2", () => {
      expect(scoreInvestmentHorizon(true as never)).toBe(2);
      expect(scoreInvestmentHorizon(42 as never)).toBe(2);
      expect(scoreInvestmentHorizon("123" as never)).toBe(2);
      expect(scoreInvestmentHorizon("not_a_horizon" as never)).toBe(2);
    });
  });

  describe("scoreDrawdownResponse", () => {
    it("returns null for falsy primitives", () => {
      expect(scoreDrawdownResponse(null)).toBeNull();
      expect(scoreDrawdownResponse(false as never)).toBeNull();
      expect(scoreDrawdownResponse("" as never)).toBeNull();
    });

    it("maps known members and falls through unknown truthy primitives to 2", () => {
      expect(scoreDrawdownResponse("reduce")).toBe(0);
      expect(scoreDrawdownResponse("stay")).toBe(1);
      expect(scoreDrawdownResponse("buy_more")).toBe(2);
      expect(scoreDrawdownResponse(true as never)).toBe(2);
      expect(scoreDrawdownResponse("999" as never)).toBe(2);
    });
  });

  describe("scoreVolatilityPreference", () => {
    it("returns null for falsy primitives", () => {
      expect(scoreVolatilityPreference(null)).toBeNull();
      expect(scoreVolatilityPreference(0 as never)).toBeNull();
      expect(scoreVolatilityPreference("" as never)).toBeNull();
    });

    it("maps known members and falls through unknown truthy primitives to 2", () => {
      expect(scoreVolatilityPreference("small")).toBe(0);
      expect(scoreVolatilityPreference("moderate")).toBe(1);
      expect(scoreVolatilityPreference("large")).toBe(2);
      expect(scoreVolatilityPreference(true as never)).toBe(2);
      expect(scoreVolatilityPreference("xl" as never)).toBe(2);
    });
  });

  describe("computeRiskScore", () => {
    it("returns null when any field is a falsy/missing primitive (no throw)", () => {
      expect(
        computeRiskScore({
          investment_horizon: null,
          drawdown_response: null,
          volatility_preference: null,
        })
      ).toBeNull();

      // A primitive passed where an object is expected: missing props => null.
      expect(computeRiskScore(true as never)).toBeNull();
      expect(computeRiskScore(0 as never)).toBeNull();
      expect(computeRiskScore("malformed" as never)).toBeNull();
    });

    it("sums fallthrough scores when fed unknown truthy primitive members", () => {
      // Each unknown-but-truthy member resolves to 2 => 2 + 2 + 2 = 6.
      expect(
        computeRiskScore({
          investment_horizon: "weird" as never,
          drawdown_response: "weird" as never,
          volatility_preference: "weird" as never,
        })
      ).toBe(6);
    });

    it("sums the canonical members deterministically", () => {
      expect(
        computeRiskScore({
          investment_horizon: "short_term",
          drawdown_response: "reduce",
          volatility_preference: "small",
        })
      ).toBe(0);
    });
  });

  describe("mapRiskProfile", () => {
    it("buckets numeric scores by the documented thresholds", () => {
      expect(mapRiskProfile(0)).toBe("conservative");
      expect(mapRiskProfile(2)).toBe("conservative");
      expect(mapRiskProfile(3)).toBe("balanced");
      expect(mapRiskProfile(4)).toBe("balanced");
      expect(mapRiskProfile(5)).toBe("aggressive");
      expect(mapRiskProfile(6)).toBe("aggressive");
    });

    it("coerces numerical-string primitives through JS comparison semantics", () => {
      // "2" <= 2 is true via numeric coercion of the comparison.
      expect(mapRiskProfile("2" as never)).toBe("conservative");
      expect(mapRiskProfile("4" as never)).toBe("balanced");
      expect(mapRiskProfile("6" as never)).toBe("aggressive");
    });

    it("treats non-numeric primitives as the aggressive fallthrough (NaN comparisons are false)", () => {
      expect(mapRiskProfile("not_a_number" as never)).toBe("aggressive");
      expect(mapRiskProfile(undefined as never)).toBe("aggressive");
    });
  });

  describe("resolveKaiOnboardingCompletion / isKaiOnboardingCompleted", () => {
    it("returns the not-completed shape for null/undefined via optional chaining", () => {
      expect(resolveKaiOnboardingCompletion(null)).toEqual({
        completed: false,
        completedAt: null,
        skippedPreferences: false,
      });
      expect(resolveKaiOnboardingCompletion(undefined)).toEqual({
        completed: false,
        completedAt: null,
        skippedPreferences: false,
      });

      expect(isKaiOnboardingCompleted(null)).toBe(false);
      expect(isKaiOnboardingCompleted(undefined)).toBe(false);
    });

    it("throws on a non-nullish primitive because optional chaining only guards nullish values", () => {
      // `true?.onboarding` is `undefined` (true is not nullish), then `.completed`
      // throws a TypeError. This pins the current, non-defensive behavior: the
      // public guard only tolerates null/undefined, not arbitrary primitives.
      expect(() => resolveKaiOnboardingCompletion(true as never)).toThrow(TypeError);
      expect(() => isKaiOnboardingCompleted(123 as never)).toThrow(TypeError);
      expect(() => isKaiOnboardingCompleted("malformed" as never)).toThrow(TypeError);
    });
  });

});
