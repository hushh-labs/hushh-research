import { describe, expect, it } from "vitest";

import { resolveAppRouteLayoutMode } from "@/lib/navigation/app-route-layout";

/**
 * Characterization tests for the pathname normalization contract inside
 * resolveAppRouteLayoutMode / resolveAppRouteLayout.
 *
 * Implementation boundaries (app-route-layout.ts):
 *
 *   function normalizePathname(pathname: string): string {
 *     const trimmed = pathname.split(/[?#]/, 1)[0]?.trim() || "/";
 *     if (trimmed === "/") return "/";
 *     const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
 *     return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
 *   }
 *
 *   function isDynamicSegment(segment: string): boolean {
 *     return segment.startsWith("[") && segment.endsWith("]");
 *   }
 *
 *   function matchRoutePattern(pathname: string, routePattern: string): boolean {
 *     const normalizedPath = normalizePathname(pathname);
 *     if (routePattern === "/") return normalizedPath === "/";
 *     const pathSegments = normalizedPath.split("/").filter(Boolean);
 *     const patternSegments = routePattern.split("/").filter(Boolean);
 *     if (pathSegments.length !== patternSegments.length) return false;
 *     return patternSegments.every((patternSegment, index) => {
 *       if (isDynamicSegment(patternSegment)) return Boolean(pathSegments[index]);
 *       return patternSegment === pathSegments[index];
 *     });
 *   }
 *
 * Why behavior is guaranteed:
 * - split(/[?#]/, 1)[0]?.trim() strips query and hash, then trims whitespace.
 * - Missing leading "/" is prepended; trailing "/" is sliced off (except root).
 * - isDynamicSegment matches any "[...]" token and accepts any non-empty segment.
 * - Unmatched routes fall back to DEFAULT_ROUTE_LAYOUT { route: "*", mode: "standard" }.
 * - Mode values ("standard" | "flow" | "redirect" | "hidden") are drawn directly
 *   from app-route-layout.contract.json — no runtime computation.
 */
describe("app route layout pathname normalization", () => {
  describe("query string stripping", () => {
    it("strips query string before route matching — /one?foo=bar normalizes to /one (standard)", () => {
      expect(resolveAppRouteLayoutMode("/one?foo=bar")).toBe("standard");
    });

    it("strips query string before route matching — /login?redirect=/ normalizes to /login (hidden)", () => {
      expect(resolveAppRouteLayoutMode("/login?redirect=/")).toBe("hidden");
    });

    it("strips query string before route matching — /one/onboarding?from=/one normalizes to /one/onboarding (flow)", () => {
      expect(resolveAppRouteLayoutMode("/one/onboarding?from=/one")).toBe(
        "flow",
      );
    });
  });

  describe("hash fragment stripping", () => {
    it("strips hash before route matching — /one#section normalizes to /one (standard)", () => {
      expect(resolveAppRouteLayoutMode("/one#section")).toBe("standard");
    });

    it("strips hash before route matching — /logout#done normalizes to /logout (hidden)", () => {
      expect(resolveAppRouteLayoutMode("/logout#done")).toBe("hidden");
    });
  });

  describe("trailing slash stripping", () => {
    it("strips trailing slash — /one/ normalizes to /one (standard)", () => {
      expect(resolveAppRouteLayoutMode("/one/")).toBe("standard");
    });

    it("strips trailing slash — /one/onboarding/ normalizes to /one/onboarding (flow)", () => {
      expect(resolveAppRouteLayoutMode("/one/onboarding/")).toBe("flow");
    });

    it("strips trailing slash — /register-phone/ normalizes to /register-phone (hidden)", () => {
      expect(resolveAppRouteLayoutMode("/register-phone/")).toBe("hidden");
    });
  });

  describe("dynamic segment matching", () => {
    it("matches /ria/clients/[userId] for any non-empty userId value", () => {
      // pathSegments=["ria","clients","user-123"], patternSegments=["ria","clients","[userId]"]
      // isDynamicSegment("[userId]") → true, Boolean("user-123") → true
      expect(resolveAppRouteLayoutMode("/ria/clients/user-123")).toBe(
        "standard",
      );
    });

    it("matches /ria/clients/[userId]/accounts/[accountId] for nested dynamic segments", () => {
      expect(
        resolveAppRouteLayoutMode("/ria/clients/user-abc/accounts/acct-1"),
      ).toBe("standard");
    });

    it("matches /ria/clients/[userId]/requests/[requestId] for nested dynamic segments", () => {
      expect(
        resolveAppRouteLayoutMode("/ria/clients/user-abc/requests/req-99"),
      ).toBe("standard");
    });

    it("matches /one/connected-systems/[systemId] for any non-empty systemId", () => {
      expect(resolveAppRouteLayoutMode("/one/connected-systems/plaid")).toBe(
        "standard",
      );
    });
  });

  describe("mode classification from contract", () => {
    it("returns hidden mode for / (auth-split entry route)", () => {
      expect(resolveAppRouteLayoutMode("/")).toBe("hidden");
    });

    it("returns hidden mode for /register-phone", () => {
      expect(resolveAppRouteLayoutMode("/register-phone")).toBe("hidden");
    });

    it("returns hidden mode for /logout", () => {
      expect(resolveAppRouteLayoutMode("/logout")).toBe("hidden");
    });

    it("returns hidden mode for /labs/profile-appearance", () => {
      expect(resolveAppRouteLayoutMode("/labs/profile-appearance")).toBe(
        "hidden",
      );
    });

    it("returns flow mode for /one/onboarding", () => {
      expect(resolveAppRouteLayoutMode("/one/onboarding")).toBe("flow");
    });

    it("returns flow mode for /ria/onboarding", () => {
      expect(resolveAppRouteLayoutMode("/ria/onboarding")).toBe("flow");
    });

    it("returns flow mode for /one/kai/import", () => {
      expect(resolveAppRouteLayoutMode("/one/kai/import")).toBe("flow");
    });

    it("returns redirect mode for /kai (legacy compatibility route)", () => {
      expect(resolveAppRouteLayoutMode("/kai")).toBe("redirect");
    });

    it("returns redirect mode for /kai/portfolio (legacy compatibility route)", () => {
      expect(resolveAppRouteLayoutMode("/kai/portfolio")).toBe("redirect");
    });

    it("returns redirect mode for /ria/workspace (compatibility alias)", () => {
      expect(resolveAppRouteLayoutMode("/ria/workspace")).toBe("redirect");
    });
  });

  describe("default fallback for unrecognized routes", () => {
    it("returns standard mode for a pathname that matches no contract entry", () => {
      // No contract entry → APP_ROUTE_LAYOUT_CONTRACT.find returns undefined
      // → falls back to DEFAULT_ROUTE_LAYOUT { route: "*", mode: "standard" }
      expect(resolveAppRouteLayoutMode("/this-route-does-not-exist-xyz")).toBe(
        "standard",
      );
    });
  });
});