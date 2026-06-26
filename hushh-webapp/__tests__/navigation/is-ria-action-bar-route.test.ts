import { describe, expect, it } from "vitest";

import { isRiaActionBarRoute } from "@/lib/navigation/routes";

/**
 * Characterization tests for isRiaActionBarRoute.
 *
 * Implementation boundary (routes.ts):
 *
 *   export function isRiaActionBarRoute(pathname: string | null | undefined): boolean {
 *     const path = pathname ?? "";
 *     return isRiaRoute(path) && !isRiaOnboardingRoute(path);
 *   }
 *
 * Truth-first:
 *   - `pathname ?? ""` coalesces null and undefined to the empty string before
 *     any routing logic runs.  The empty string satisfies neither isRiaRoute
 *     nor isRiaOnboardingRoute, so both null and undefined → false.
 *   - The result is the conjunction of two deterministic boolean guards:
 *       isRiaRoute(path)          → pathname === "/ria" || startsWith("/ria/")
 *       !isRiaOnboardingRoute(path) → NOT (=== "/ria/onboarding" || startsWith("/ria/onboarding/"))
 *   - Therefore every RIA onboarding path is excluded regardless of depth.
 *   - Non-RIA paths fail isRiaRoute and short-circuit to false.
 */
describe("isRiaActionBarRoute", () => {
  describe("nullish coalescing contract", () => {
    it("returns false for null — coalesced to empty string, fails isRiaRoute", () => {
      expect(isRiaActionBarRoute(null)).toBe(false);
    });

    it("returns false for undefined — coalesced to empty string, fails isRiaRoute", () => {
      expect(isRiaActionBarRoute(undefined)).toBe(false);
    });

    it("returns false for empty string — fails isRiaRoute directly", () => {
      expect(isRiaActionBarRoute("")).toBe(false);
    });
  });

  describe("onboarding exclusion contract", () => {
    it("returns false for the exact RIA onboarding route", () => {
      // isRiaRoute("/ria/onboarding") = true  BUT  isRiaOnboardingRoute = true → excluded
      expect(isRiaActionBarRoute("/ria/onboarding")).toBe(false);
    });

    it("returns false for a nested path under RIA onboarding", () => {
      expect(isRiaActionBarRoute("/ria/onboarding/step-2")).toBe(false);
    });

    it("returns false for a deeply nested RIA onboarding path", () => {
      expect(isRiaActionBarRoute("/ria/onboarding/step-2/confirm")).toBe(false);
    });
  });

  describe("positive RIA routes — action bar shown", () => {
    it("returns true for the RIA home route", () => {
      expect(isRiaActionBarRoute("/ria")).toBe(true);
    });

    it("returns true for the RIA clients list route", () => {
      expect(isRiaActionBarRoute("/ria/clients")).toBe(true);
    });

    it("returns true for a nested RIA clients path", () => {
      expect(isRiaActionBarRoute("/ria/clients/user-1")).toBe(true);
    });

    it("returns true for the RIA picks route", () => {
      expect(isRiaActionBarRoute("/ria/picks")).toBe(true);
    });

    it("returns true for the RIA settings route", () => {
      expect(isRiaActionBarRoute("/ria/settings")).toBe(true);
    });
  });

  describe("non-RIA routes — action bar not shown", () => {
    it("returns false for an investor route", () => {
      expect(isRiaActionBarRoute("/one/kai")).toBe(false);
    });

    it("returns false for the marketplace route", () => {
      expect(isRiaActionBarRoute("/marketplace")).toBe(false);
    });

    it("returns false for a completely unrelated path", () => {
      expect(isRiaActionBarRoute("/profile")).toBe(false);
    });
  });
});