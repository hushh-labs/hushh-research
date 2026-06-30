import { describe, expect, it } from "vitest";

import {
  RIA_ROUTE_TABS,
  activeRiaRouteTabFromPath,
} from "@/lib/navigation/ria-route-tabs";
import { ROUTES } from "@/lib/navigation/routes";

describe("RIA_ROUTE_TABS", () => {
  it("exports four tabs in stable order", () => {
    expect(RIA_ROUTE_TABS.map((tab) => tab.id)).toEqual([
      "home",
      "clients",
      "connect",
      "picks",
    ]);
  });

  it("uses unique tab ids", () => {
    const ids = RIA_ROUTE_TABS.map((tab) => tab.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses unique hrefs", () => {
    const hrefs = RIA_ROUTE_TABS.map((tab) => tab.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("uses non-empty labels", () => {
    for (const tab of RIA_ROUTE_TABS) {
      expect(tab.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("matches ROUTES constants", () => {
    const byId = Object.fromEntries(
      RIA_ROUTE_TABS.map((tab) => [tab.id, tab.href]),
    );

    expect(byId.home).toBe(ROUTES.RIA_HOME);
    expect(byId.clients).toBe(ROUTES.RIA_CLIENTS);
    expect(byId.connect).toBe(ROUTES.MARKETPLACE);
    expect(byId.picks).toBe(ROUTES.RIA_PICKS);
  });
});

describe("activeRiaRouteTabFromPath", () => {
  it("resolves home routes", () => {
    expect(activeRiaRouteTabFromPath(ROUTES.RIA_HOME)).toBe(
      "home",
    );
  });

  it("resolves clients routes", () => {
    expect(activeRiaRouteTabFromPath(ROUTES.RIA_CLIENTS)).toBe(
      "clients",
    );
  });

  it("resolves connect routes", () => {
    expect(activeRiaRouteTabFromPath(ROUTES.MARKETPLACE)).toBe(
      "connect",
    );
  });

  it("resolves picks routes", () => {
    expect(activeRiaRouteTabFromPath(ROUTES.RIA_PICKS)).toBe(
      "picks",
    );
  });

  it("falls back to home for unknown paths", () => {
    expect(activeRiaRouteTabFromPath("/unknown")).toBe(
      "home",
    );
  });
});