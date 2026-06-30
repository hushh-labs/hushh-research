import { describe, expect, it } from "vitest";

import { activeKaiRouteTabFromPath } from "@/lib/navigation/kai-route-tabs";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Characterization tests: activeKaiRouteTabFromPath — legacy path tab resolution
 *
 * Implementation boundary (kai-route-tabs.ts):
 *
 * The function evaluates an ordered if-chain. The chain order determines
 * which tab wins when a path could satisfy multiple predicates.
 *
 * Step 1 — connect:
 *   pathname.startsWith(ROUTES.MARKETPLACE)
 *
 * Step 2 — market (exact + query-prefixed):
 *   pathname === ROUTES.KAI_HOME            ("/one/kai")      [modern]
 *   pathname === ROUTES.LEGACY_KAI_HOME     ("/kai")          [legacy]
 *   pathname.startsWith(ROUTES.KAI_HOME + "?")               [modern + query]
 *   pathname.startsWith(ROUTES.LEGACY_KAI_HOME + "?")        [legacy + query]
 *
 * Step 3 — analysis (precedes dashboard):
 *   pathname.startsWith(ROUTES.KAI_ANALYSIS)                 ("/one/kai/analysis")
 *   pathname.startsWith(ROUTES.LEGACY_KAI_ANALYSIS)          ("/kai/analysis")
 *   pathname.startsWith("/kai/dashboard/analysis")            [hard-coded literal]
 *   pathname.startsWith("/one/kai/dashboard/analysis")        [hard-coded literal]
 *
 * Step 4 — dashboard:
 *   pathname.startsWith(ROUTES.KAI_DASHBOARD)                ("/one/kai/portfolio")
 *   pathname.startsWith(ROUTES.KAI_INVESTMENTS)              ("/one/kai/investments")
 *   pathname.startsWith(ROUTES.KAI_FUNDING_TRADE)            ("/one/kai/funding-trade")
 *   pathname.startsWith(ROUTES.LEGACY_KAI_PORTFOLIO)         ("/kai/portfolio")
 *   pathname.startsWith(ROUTES.LEGACY_KAI_INVESTMENTS)       ("/kai/investments")
 *   pathname.startsWith(ROUTES.LEGACY_KAI_FUNDING_TRADE)     ("/kai/funding-trade")
 *   pathname.startsWith("/kai/dashboard")                     [hard-coded literal]
 *   pathname.startsWith("/one/kai/dashboard")                 [hard-coded literal]
 *   pathname.startsWith(ROUTES.KAI_OPTIMIZE)                 ("/one/kai/optimize")
 *
 * Step 5 — fallback: "market"
 *
 * This file covers every legacy path and hard-coded literal not addressed
 * by the existing kai-route-tabs.test.ts. The priority ordering of step 3
 * before step 4 is explicitly characterized for paths that satisfy both.
 */

describe("activeKaiRouteTabFromPath — legacy path tab resolution", () => {
  describe("LEGACY_KAI_HOME resolves to market", () => {
    it("resolves /kai (LEGACY_KAI_HOME) to market via exact equality", () => {
      expect(activeKaiRouteTabFromPath(ROUTES.LEGACY_KAI_HOME)).toBe("market");
    });

    it("resolves /kai with a query string to market via startsWith", () => {
      expect(
        activeKaiRouteTabFromPath(`${ROUTES.LEGACY_KAI_HOME}?tab=something`),
      ).toBe("market");
    });

    it("resolves /one/kai with a query string to market via startsWith", () => {
      expect(
        activeKaiRouteTabFromPath(`${ROUTES.KAI_HOME}?tab=something`),
      ).toBe("market");
    });
  });

  describe("LEGACY_KAI_ANALYSIS resolves to analysis", () => {
    it("resolves /kai/analysis (LEGACY_KAI_ANALYSIS) to analysis", () => {
      expect(activeKaiRouteTabFromPath(ROUTES.LEGACY_KAI_ANALYSIS)).toBe(
        "analysis",
      );
    });

    it("resolves a path nested under /kai/analysis to analysis via startsWith", () => {
      expect(
        activeKaiRouteTabFromPath(`${ROUTES.LEGACY_KAI_ANALYSIS}/detail`),
      ).toBe("analysis");
    });
  });

  describe("hard-coded /kai/dashboard/analysis resolves to analysis, not dashboard", () => {
    it("resolves /kai/dashboard/analysis to analysis (analysis check precedes dashboard check)", () => {
      expect(activeKaiRouteTabFromPath("/kai/dashboard/analysis")).toBe(
        "analysis",
      );
    });

    it("resolves /one/kai/dashboard/analysis to analysis (analysis check precedes dashboard check)", () => {
      expect(activeKaiRouteTabFromPath("/one/kai/dashboard/analysis")).toBe(
        "analysis",
      );
    });
  });

  describe("hard-coded /kai/dashboard and /one/kai/dashboard resolve to dashboard", () => {
    it("resolves /kai/dashboard to dashboard", () => {
      expect(activeKaiRouteTabFromPath("/kai/dashboard")).toBe("dashboard");
    });

    it("resolves /one/kai/dashboard to dashboard", () => {
      expect(activeKaiRouteTabFromPath("/one/kai/dashboard")).toBe("dashboard");
    });
  });

  describe("legacy portfolio and investment paths resolve to dashboard", () => {
    it("resolves LEGACY_KAI_PORTFOLIO (/kai/portfolio) to dashboard", () => {
      expect(activeKaiRouteTabFromPath(ROUTES.LEGACY_KAI_PORTFOLIO)).toBe(
        "dashboard",
      );
    });

    it("resolves LEGACY_KAI_INVESTMENTS (/kai/investments) to dashboard", () => {
      expect(activeKaiRouteTabFromPath(ROUTES.LEGACY_KAI_INVESTMENTS)).toBe(
        "dashboard",
      );
    });

    it("resolves LEGACY_KAI_FUNDING_TRADE (/kai/funding-trade) to dashboard", () => {
      expect(activeKaiRouteTabFromPath(ROUTES.LEGACY_KAI_FUNDING_TRADE)).toBe(
        "dashboard",
      );
    });
  });

  describe("modern investment and optimize paths resolve to dashboard", () => {
    it("resolves KAI_INVESTMENTS (/one/kai/investments) to dashboard", () => {
      expect(activeKaiRouteTabFromPath(ROUTES.KAI_INVESTMENTS)).toBe(
        "dashboard",
      );
    });

    it("resolves KAI_FUNDING_TRADE (/one/kai/funding-trade) to dashboard", () => {
      expect(activeKaiRouteTabFromPath(ROUTES.KAI_FUNDING_TRADE)).toBe(
        "dashboard",
      );
    });

    it("resolves KAI_OPTIMIZE (/one/kai/optimize) to dashboard", () => {
      expect(activeKaiRouteTabFromPath(ROUTES.KAI_OPTIMIZE)).toBe("dashboard");
    });
  });
});