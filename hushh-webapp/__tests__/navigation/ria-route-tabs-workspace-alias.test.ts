import { describe, expect, it } from "vitest";

import { activeRiaRouteTabFromPath } from "@/lib/navigation/ria-route-tabs";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * Characterization tests for activeRiaRouteTabFromPath.
 *
 * The existing ria-route-tabs.test.ts covers:
 *   - exact equality for RIA_HOME, RIA_CLIENTS, MARKETPLACE, RIA_PICKS
 *   - unknown-path fallback → "home"
 *
 * This file pins three implementation boundaries that are NOT covered there:
 *
 *   1. pathname === ROUTES.RIA_WORKSPACE   → "clients"  (workspace alias, exact ===)
 *   2. pathname.startsWith(RIA_CLIENTS)    → "clients"  (nested client path)
 *   3. pathname.startsWith(`${RIA_HOME}?`) → "home"     (query string on home root)
 *
 * All three branches exist in the implementation and are deterministic —
 * no mocks or async required.
 */

describe("activeRiaRouteTabFromPath — workspace alias", () => {
  it("maps RIA_WORKSPACE to the clients tab via exact equality", () => {
    // Implementation: pathname === ROUTES.RIA_WORKSPACE → return "clients"
    // This is a named alias that redirects the workspace route to the clients tab.
    expect(activeRiaRouteTabFromPath(ROUTES.RIA_WORKSPACE)).toBe("clients");
  });
});

describe("activeRiaRouteTabFromPath — startsWith boundaries", () => {
  it("maps a nested client path to clients via startsWith(RIA_CLIENTS)", () => {
    // startsWith(ROUTES.RIA_CLIENTS) matches /ria/clients/<anything>
    // The existing test only exercises the exact ROUTES.RIA_CLIENTS root.
    expect(activeRiaRouteTabFromPath(`${ROUTES.RIA_CLIENTS}/user-1`)).toBe("clients");
  });

  it("maps a deeply nested client path to clients via startsWith(RIA_CLIENTS)", () => {
    expect(
      activeRiaRouteTabFromPath(`${ROUTES.RIA_CLIENTS}/user-1/workspace`),
    ).toBe("clients");
  });

  it("maps a nested picks path to picks via startsWith(RIA_PICKS)", () => {
    // startsWith(ROUTES.RIA_PICKS) matches /ria/picks/<anything>
    expect(activeRiaRouteTabFromPath(`${ROUTES.RIA_PICKS}/pick-1`)).toBe("picks");
  });
});

describe("activeRiaRouteTabFromPath — home with query string", () => {
  it("maps RIA_HOME with a query string to home via the startsWith guard", () => {
    // Implementation: pathname.startsWith(`${ROUTES.RIA_HOME}?`) → return "home"
    // This is the second clause in the home check, guarding against a query
    // string being mistaken for a sub-path.
    expect(activeRiaRouteTabFromPath(`${ROUTES.RIA_HOME}?foo=bar`)).toBe("home");
  });

  it("maps RIA_HOME with a tab query param to home", () => {
    expect(activeRiaRouteTabFromPath(`${ROUTES.RIA_HOME}?tab=active`)).toBe("home");
  });
});