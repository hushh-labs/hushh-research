import { describe, it, expect } from "vitest";

import {
  resolveKaiOnboardingCompletion,
  isKaiOnboardingCompleted,
  type KaiProfileV2,
} from "@/lib/services/kai-profile-service";

/**
 * Characterization tests for the public profile retrieval getters that surface
 * onboarding sub-objects from a (possibly partially initialized) profile payload.
 *
 * These pin the CURRENT behavior so future refactors surface accidental changes;
 * they do not assert what the API *should* do.
 *
 * Verified source: hushh-webapp/lib/services/kai-profile-service.ts (504-518)
 *   resolveKaiOnboardingCompletion() reads:
 *     completed:           profile?.onboarding.completed === true
 *     completedAt:         profile?.onboarding.completed_at ?? null
 *     skippedPreferences:  profile?.onboarding.skipped_preferences === true
 *   isKaiOnboardingCompleted() delegates to the `completed` field above.
 *
 * Consequence: when individual onboarding option fields are omitted from the
 * initialized configuration payload, the public getter populates safe defaults
 * (boolean fields => false, completedAt => null) rather than leaking undefined.
 */

/**
 * Builds a profile whose `onboarding` block only contains the supplied fields,
 * simulating a payload where the remaining option fields were never written.
 */
function profileWithPartialOnboarding(
  onboarding: Partial<KaiProfileV2["onboarding"]>
): KaiProfileV2 {
  return {
    schema_version: 2,
    onboarding: onboarding as KaiProfileV2["onboarding"],
    preferences: {
      investment_horizon: null,
      investment_horizon_selected_at: null,
      investment_horizon_anchor_at: null,
      drawdown_response: null,
      drawdown_response_selected_at: null,
      volatility_preference: null,
      volatility_preference_selected_at: null,
      risk_score: null,
      risk_profile: null,
      risk_profile_selected_at: null,
    },
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("Profile preferences getters — safe defaults for omitted option blocks", () => {
  describe("resolveKaiOnboardingCompletion", () => {
    it("fills every field with a safe default when the onboarding block is entirely empty", () => {
      const result = resolveKaiOnboardingCompletion(profileWithPartialOnboarding({}));
      expect(result).toEqual({
        completed: false,
        completedAt: null,
        skippedPreferences: false,
      });
    });

    it("defaults completedAt to null while preserving an explicit completed flag", () => {
      const result = resolveKaiOnboardingCompletion(
        profileWithPartialOnboarding({ completed: true })
      );
      expect(result.completed).toBe(true);
      // completed_at was omitted from the payload => `?? null` fallback applies.
      expect(result.completedAt).toBeNull();
      // skipped_preferences omitted => strict `=== true` yields false.
      expect(result.skippedPreferences).toBe(false);
    });

    it("surfaces an explicit completed_at string when present", () => {
      const completedAt = "2026-02-02T12:00:00.000Z";
      const result = resolveKaiOnboardingCompletion(
        profileWithPartialOnboarding({ completed: true, completed_at: completedAt })
      );
      expect(result).toEqual({
        completed: true,
        completedAt,
        skippedPreferences: false,
      });
    });

    it("coerces non-true completed/skipped option values down to false", () => {
      const result = resolveKaiOnboardingCompletion(
        profileWithPartialOnboarding({
          // Anything other than the boolean literal `true` is treated as false.
          completed: undefined as never,
          skipped_preferences: undefined as never,
        })
      );
      expect(result.completed).toBe(false);
      expect(result.skippedPreferences).toBe(false);
    });

    it("preserves an explicit skipped_preferences=true option", () => {
      const result = resolveKaiOnboardingCompletion(
        profileWithPartialOnboarding({ skipped_preferences: true })
      );
      expect(result.skippedPreferences).toBe(true);
      expect(result.completed).toBe(false);
      expect(result.completedAt).toBeNull();
    });

    it("returns the fully-defaulted block for null/undefined profiles", () => {
      const expected = {
        completed: false,
        completedAt: null,
        skippedPreferences: false,
      };
      expect(resolveKaiOnboardingCompletion(null)).toEqual(expected);
      expect(resolveKaiOnboardingCompletion(undefined)).toEqual(expected);
    });
  });

  describe("isKaiOnboardingCompleted", () => {
    it("reports false when the completed option is omitted", () => {
      expect(isKaiOnboardingCompleted(profileWithPartialOnboarding({}))).toBe(false);
    });

    it("reports true only for an explicit completed=true option", () => {
      expect(
        isKaiOnboardingCompleted(profileWithPartialOnboarding({ completed: true }))
      ).toBe(true);
    });

    it("reports false for null/undefined profiles", () => {
      expect(isKaiOnboardingCompleted(null)).toBe(false);
      expect(isKaiOnboardingCompleted(undefined)).toBe(false);
    });
  });
});
