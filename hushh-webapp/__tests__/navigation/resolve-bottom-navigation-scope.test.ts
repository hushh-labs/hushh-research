import { describe, expect, it } from "vitest";

import { resolveBottomNavigationScope } from "@/lib/navigation/app-bottom-nav";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Characterization tests for resolveBottomNavigationScope.
 *
 * Implementation boundary (lib/navigation/app-bottom-nav.ts):
 *
 *   export function resolveBottomNavigationScope(
 *     pathname: string | null | undefined,
 *     _activePersona: string | null | undefined,
 *   ): AppBottomNavScope {
 *     const normalizedPathname = normalizeBottomNavPathname(pathname);
 *     if (isBottomNavRoute(normalizedPathname, ROUTES.RIA_HOME)) return "ria";
 *     if (
 *       isBottomNavRoute(normalizedPathname, ROUTES.KAI_HOME) ||
 *       isBottomNavRoute(normalizedPathname, ROUTES.LEGACY_KAI_HOME)
 *     ) return "investor";
 *     return "one";
 *   }
 *
 * where isBottomNavRoute(p, r) ≡ p === r || p.startsWith(`${r}/`)
 *
 * ROUTE VALUES (from ROUTES const):
 *   ROUTES.RIA_HOME          = "/ria"
 *   ROUTES.KAI_HOME          = "/one/kai"
 *   ROUTES.LEGACY_KAI_HOME   = "/kai"
 *
 * DUPLICATE COVERAGE CHECK — __tests__/navigation/app-bottom-nav.test.ts already pins:
 *   "/" → "one"
 *   "/one/location", "/consents", "/agent", ROUTES.MARKETPLACE → "one"
 *   "/kaizen" → "one"  (proves /kaizen ≠ /kai and not startsWith("/kai/"))
 *   "/one/kai/portfolio" → "investor"  (a child of KAI_HOME, not the root)
 *   "/ria/clients"       → "ria"       (a child of RIA_HOME, not the root)
 *
 * These tests cover ONLY the boundaries not exercised above.
 *
 * Why deterministic:
 *   normalizeBottomNavPathname is pure string manipulation.
 *   isBottomNavRoute is a pure string comparison.
 *   ROUTES constants are frozen at module load. No I/O, no state.
 *
 * No vi.mock required: the existing app-bottom-nav.test.ts imports the same
 *   module without any mock setup, proving the consent-sheet-route module-level
 *   import does not block test execution in this environment.
 */
describe("resolveBottomNavigationScope — boundary characterization", () => {
  describe("null and undefined pathnames", () => {
    it("returns 'one' for null — normalizeBottomNavPathname yields '' which matches no branch", () => {
      // null?.split → undefined → base = "" → guard: base==="" but pathname!=="/" → ""
      // isBottomNavRoute("", ROUTES.RIA_HOME)  → false
      // isBottomNavRoute("", ROUTES.KAI_HOME)  → false
      // → falls through to default "one"
      expect(resolveBottomNavigationScope(null, null)).toBe("one");
    });

    it("returns 'one' for undefined — same normalization path as null", () => {
      expect(resolveBottomNavigationScope(undefined, null)).toBe("one");
    });
  });

  describe("exact route root boundaries", () => {
    it("returns 'ria' for ROUTES.RIA_HOME ('/ria') exactly", () => {
      // isBottomNavRoute("/ria", "/ria") → "/ria" === "/ria" → true → first branch fires
      expect(resolveBottomNavigationScope(ROUTES.RIA_HOME, null)).toBe("ria");
    });

    it("returns 'investor' for ROUTES.KAI_HOME ('/one/kai') exactly", () => {
      // isBottomNavRoute("/one/kai", "/one/kai") → equality → true → second branch fires
      expect(resolveBottomNavigationScope(ROUTES.KAI_HOME, null)).toBe("investor");
    });

    it("returns 'investor' for ROUTES.LEGACY_KAI_HOME ('/kai') exactly", () => {
      // isBottomNavRoute("/kai", "/kai") → equality → true → second branch fires
      expect(resolveBottomNavigationScope(ROUTES.LEGACY_KAI_HOME, null)).toBe("investor");
    });
  });

  describe("LEGACY_KAI_HOME child paths", () => {
    it("returns 'investor' for '/kai/analysis' — startsWith('/kai/') satisfies LEGACY_KAI_HOME branch", () => {
      // isBottomNavRoute("/kai/analysis", "/kai")
      //   → "/kai/analysis" === "/kai" → false
      //   → "/kai/analysis".startsWith("/kai/") → true
      expect(resolveBottomNavigationScope("/kai/analysis", null)).toBe("investor");
    });

    it("returns 'investor' for '/kai/portfolio' — another direct child of LEGACY_KAI_HOME", () => {
      expect(resolveBottomNavigationScope("/kai/portfolio", null)).toBe("investor");
    });
  });
});