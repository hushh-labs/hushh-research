import { describe, expect, it } from "vitest";

import { getRouteScope } from "@/lib/navigation/route-scope";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Characterization tests: getRouteScope
 *
 * Implementation boundary (route-scope.ts):
 *
 *   Guard: !pathname → "unknown"
 *
 *   Ordered if-chain:
 *     1. isRoute(ONE_ONBOARDING) || isRoute(LEGACY_ONE_KAI_ONBOARDING)
 *        || isRoute(LEGACY_KAI_ONBOARDING) || isRoute(RIA_ONBOARDING)
 *        → "onboarding"
 *     2. isRoute(KAI_HOME) || isRoute(LEGACY_KAI_HOME) → "investor"
 *     3. isRoute(RIA_HOME)                             → "ria"
 *     4. HOME === | ONE_HOME === | isRoute(AGENT) | … | isRoute(MARKETPLACE)
 *        → "shared"
 *     5. LOGIN === | LOGOUT ===                        → "public"
 *     6. fallback                                      → "unknown"
 *
 * Critical ordering boundary:
 *   RIA_ONBOARDING ("/ria/onboarding") satisfies isRoute(RIA_HOME)
 *   because it starts with "/ria/". The onboarding check (step 1) fires
 *   before the ria check (step 3), so it resolves to "onboarding" not "ria".
 *   This must be locked — a branch reorder would silently break it.
 */

describe("getRouteScope", () => {
  describe("unknown", () => {
    it("returns unknown for an empty pathname", () => {
      expect(getRouteScope("")).toBe("unknown");
    });

    it("returns unknown for an unrecognized path", () => {
      expect(getRouteScope("/unrecognized")).toBe("unknown");
    });
  });

  describe("onboarding", () => {
    it("returns onboarding for the canonical onboarding route", () => {
      expect(getRouteScope(ROUTES.ONE_ONBOARDING)).toBe("onboarding");
    });

    it("returns onboarding for RIA_ONBOARDING — onboarding check precedes ria check", () => {
      // /ria/onboarding starts with /ria/ and would satisfy isRoute(RIA_HOME),
      // but the onboarding branch fires first. This locks the branch ordering.
      expect(getRouteScope(ROUTES.RIA_ONBOARDING)).toBe("onboarding");
    });
  });

  describe("investor", () => {
    it("returns investor for KAI_HOME", () => {
      expect(getRouteScope(ROUTES.KAI_HOME)).toBe("investor");
    });
  });

  describe("ria", () => {
    it("returns ria for RIA_HOME", () => {
      expect(getRouteScope(ROUTES.RIA_HOME)).toBe("ria");
    });
  });

  describe("shared", () => {
    it("returns shared for MARKETPLACE", () => {
      expect(getRouteScope(ROUTES.MARKETPLACE)).toBe("shared");
    });
  });

  describe("public", () => {
    it("returns public for LOGIN", () => {
      expect(getRouteScope(ROUTES.LOGIN)).toBe("public");
    });
  });
});