import { describe, expect, it } from "vitest";

import { isRiaOnboardingRoute } from "@/lib/navigation/routes";

/**
 * Characterization tests for isRiaOnboardingRoute.
 *
 * Implementation boundary (routes.ts):
 *
 *   export function isRiaOnboardingRoute(pathname: string): boolean {
 *     return (
 *       pathname === ROUTES.RIA_ONBOARDING ||
 *       pathname.startsWith(`${ROUTES.RIA_ONBOARDING}/`)
 *     );
 *   }
 *
 * ROUTES.RIA_ONBOARDING = "/ria/onboarding"
 *
 * Truth-first:
 *   - Arm 1: exact === "/ria/onboarding" → true
 *   - Arm 2: startsWith("/ria/onboarding/") → true for any sub-path
 *   - "/ria/onboarding-extra" fails both: not exact, and does not start
 *     with "/ria/onboarding/" (the trailing slash prevents false positives).
 *   - Inputs without the "/ria/onboarding" prefix always fail both arms.
 *   - No query-string stripping, no normalization — pathname is tested as-is.
 */
describe("isRiaOnboardingRoute", () => {
  describe("exact match — arm 1", () => {
    it("returns true for the exact RIA_ONBOARDING value", () => {
      expect(isRiaOnboardingRoute("/ria/onboarding")).toBe(true);
    });
  });

  describe("startsWith contract — arm 2", () => {
    it("returns true for the route followed by a bare slash", () => {
      // "/ria/onboarding/" satisfies startsWith("/ria/onboarding/")
      expect(isRiaOnboardingRoute("/ria/onboarding/")).toBe(true);
    });

    it("returns true for a single-level sub-path", () => {
      expect(isRiaOnboardingRoute("/ria/onboarding/step-2")).toBe(true);
    });

    it("returns true for a deeply nested sub-path", () => {
      expect(isRiaOnboardingRoute("/ria/onboarding/step-2/confirm")).toBe(true);
    });
  });

  describe("false cases", () => {
    it("returns false for the bare RIA home route", () => {
      expect(isRiaOnboardingRoute("/ria")).toBe(false);
    });

    it("returns false when suffix has no slash separator — no false-positive prefix match", () => {
      // "/ria/onboarding-extra" does NOT startWith "/ria/onboarding/"
      expect(isRiaOnboardingRoute("/ria/onboarding-extra")).toBe(false);
    });

    it("returns false for a non-RIA onboarding path", () => {
      expect(isRiaOnboardingRoute("/one/onboarding")).toBe(false);
    });

    it("returns false for the legacy kai onboarding path", () => {
      expect(isRiaOnboardingRoute("/kai/onboarding")).toBe(false);
    });

    it("returns false for an empty string", () => {
      expect(isRiaOnboardingRoute("")).toBe(false);
    });

    it("returns false for a completely unrelated path", () => {
      expect(isRiaOnboardingRoute("/marketplace")).toBe(false);
    });
  });
});