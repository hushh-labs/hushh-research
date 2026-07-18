import { describe, expect, it } from "vitest";

import {
  resolveInvestorActiveNav,
  resolveRiaActiveNav,
} from "@/lib/navigation/app-bottom-nav";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Characterization tests for the global-path override guards in
 * resolveInvestorActiveNav and resolveRiaActiveNav.
 *
 * The existing app-bottom-nav.test.ts covers:
 *   - route-tab dispatch: KAI_HOME → "finance", RIA_HOME → "ria-home", etc.
 *   - resolveBottomNavHref / resolveBottomNavAction / option keys
 *
 * It does NOT exercise the three guard clauses that run BEFORE route-tab
 * dispatch in both resolvers:
 *
 *   1. HOME / ONE_HOME → "dashboard"  (bypasses kai/ria tab dispatch entirely)
 *   2. AGENT           → "search"     (bypasses kai/ria tab dispatch entirely)
 *   3. PROFILE (+ startsWith) → "profile" (bypasses kai/ria tab dispatch entirely)
 *
 * These guards are identical in both resolvers and are documented here as
 * independent describe blocks for clarity.
 */

describe("resolveInvestorActiveNav — global overrides before kai tab dispatch", () => {
  it("returns dashboard for HOME, bypassing kai tab dispatch", () => {
    // Guard: normalizedPathname === ROUTES.HOME → return "dashboard"
    // ROUTES.HOME resolves to the root path; this fires before activeKaiRouteTabFromPath.
    expect(resolveInvestorActiveNav(ROUTES.HOME)).toBe("dashboard");
  });

  it("returns dashboard for ONE_HOME, bypassing kai tab dispatch", () => {
    // Guard: normalizedPathname === ROUTES.ONE_HOME → return "dashboard"
    expect(resolveInvestorActiveNav(ROUTES.ONE_HOME)).toBe("dashboard");
  });

  it("returns search for AGENT, bypassing kai tab dispatch", () => {
    // Guard: normalizedPathname === ROUTES.AGENT → return "search"
    expect(resolveInvestorActiveNav(ROUTES.AGENT)).toBe("search");
  });

  it("returns profile for PROFILE exact path, bypassing kai tab dispatch", () => {
    // Guard: isBottomNavRoute(normalizedPathname, ROUTES.PROFILE)
    // isBottomNavRoute checks exact === first.
    expect(resolveInvestorActiveNav(ROUTES.PROFILE)).toBe("profile");
  });

  it("returns profile for a nested profile path via startsWith in isBottomNavRoute", () => {
    // isBottomNavRoute: pathname.startsWith(`${route}/`) matches sub-paths.
    expect(resolveInvestorActiveNav(`${ROUTES.PROFILE}/settings`)).toBe("profile");
  });
});

describe("resolveRiaActiveNav — global overrides before ria tab dispatch", () => {
  it("returns dashboard for HOME, bypassing ria tab dispatch", () => {
    // Guard: normalizedPathname === ROUTES.HOME → return "dashboard"
    // Fires before activeRiaRouteTabFromPath is called.
    expect(resolveRiaActiveNav(ROUTES.HOME)).toBe("dashboard");
  });

  it("returns dashboard for ONE_HOME, bypassing ria tab dispatch", () => {
    expect(resolveRiaActiveNav(ROUTES.ONE_HOME)).toBe("dashboard");
  });

  it("returns search for AGENT, bypassing ria tab dispatch", () => {
    expect(resolveRiaActiveNav(ROUTES.AGENT)).toBe("search");
  });

  it("returns profile for PROFILE exact path, bypassing ria tab dispatch", () => {
    expect(resolveRiaActiveNav(ROUTES.PROFILE)).toBe("profile");
  });

  it("returns profile for a nested profile path via startsWith in isBottomNavRoute", () => {
    expect(resolveRiaActiveNav(`${ROUTES.PROFILE}/settings`)).toBe("profile");
  });
});