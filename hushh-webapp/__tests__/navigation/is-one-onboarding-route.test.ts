import { describe, expect, it } from "vitest";

import { isOneOnboardingRoute } from "@/lib/navigation/routes";

/**
 * Characterization tests for isOneOnboardingRoute.
 *
 * Implementation (lib/navigation/routes.ts):
 *
 *   export function isOneOnboardingRoute(pathname: string): boolean {
 *     return (
 *       pathname === ROUTES.ONE_ONBOARDING ||                             // "/one/onboarding"
 *       pathname.startsWith(`${ROUTES.ONE_ONBOARDING}/`) ||               // "/one/onboarding/*"
 *       pathname === ROUTES.LEGACY_ONE_KAI_ONBOARDING ||                  // "/one/kai/onboarding"
 *       pathname.startsWith(`${ROUTES.LEGACY_ONE_KAI_ONBOARDING}/`) ||    // "/one/kai/onboarding/*"
 *       pathname === ROUTES.LEGACY_KAI_ONBOARDING ||                      // "/kai/onboarding"
 *       pathname.startsWith(`${ROUTES.LEGACY_KAI_ONBOARDING}/`)           // "/kai/onboarding/*"
 *     );
 *   }
 *
 * Three canonical paths — one current, two legacy — each with an exact-match
 * AND a prefix-match branch: 6 conditions in total.
 *
 * Note: isKaiOnboardingRoute is a re-export alias (`export const isKaiOnboardingRoute = isOneOnboardingRoute`).
 * These tests use the canonical function name directly.
 */
describe("isOneOnboardingRoute", () => {
  describe("canonical onboarding route — /one/onboarding", () => {
    it("returns true for the exact canonical onboarding route", () => {
      expect(isOneOnboardingRoute("/one/onboarding")).toBe(true);
    });

    it("returns true for a path nested under the canonical onboarding route", () => {
      expect(isOneOnboardingRoute("/one/onboarding/complete")).toBe(true);
    });
  });

  describe("legacy ONE-KAI onboarding route — /one/kai/onboarding", () => {
    it("returns true for the exact legacy one-kai onboarding route", () => {
      expect(isOneOnboardingRoute("/one/kai/onboarding")).toBe(true);
    });

    it("returns true for a path nested under the legacy one-kai onboarding route", () => {
      expect(isOneOnboardingRoute("/one/kai/onboarding/step-2")).toBe(true);
    });
  });

  describe("legacy KAI onboarding route — /kai/onboarding", () => {
    it("returns true for the exact legacy kai onboarding route", () => {
      expect(isOneOnboardingRoute("/kai/onboarding")).toBe(true);
    });

    it("returns true for a path nested under the legacy kai onboarding route", () => {
      expect(isOneOnboardingRoute("/kai/onboarding/complete")).toBe(true);
    });
  });

  describe("non-onboarding routes — return false", () => {
    it("returns false for the investor KAI home route", () => {
      expect(isOneOnboardingRoute("/one/kai")).toBe(false);
    });

    it("returns false for the RIA onboarding route (different namespace)", () => {
      // RIA onboarding (/ria/onboarding) is a distinct route — NOT covered by this function
      expect(isOneOnboardingRoute("/ria/onboarding")).toBe(false);
    });

    it("returns false for a path that merely starts with /one", () => {
      expect(isOneOnboardingRoute("/one")).toBe(false);
    });

    it("returns false for an empty string", () => {
      expect(isOneOnboardingRoute("")).toBe(false);
    });
  });
});