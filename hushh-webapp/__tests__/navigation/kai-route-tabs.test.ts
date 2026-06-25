import { describe, expect, it } from "vitest";

import {
  KAI_ROUTE_TABS,
  activeKaiRouteTabFromPath,
  getAdjacentKaiRouteHref,
} from "@/lib/navigation/kai-route-tabs";
import { ROUTES } from "@/lib/navigation/routes";

describe("KAI_ROUTE_TABS", () => {
  it("exports four tabs in stable order", () => {
    expect(KAI_ROUTE_TABS.map((tab) => tab.id)).toEqual([
      "market",
      "dashboard",
      "connect",
      "analysis",
    ]);
  });

  it("uses unique tab ids", () => {
    const ids = KAI_ROUTE_TABS.map((tab) => tab.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses unique hrefs", () => {
    const hrefs = KAI_ROUTE_TABS.map((tab) => tab.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("uses non-empty labels", () => {
    for (const tab of KAI_ROUTE_TABS) {
      expect(tab.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("activeKaiRouteTabFromPath", () => {
  it("resolves market routes", () => {
    expect(activeKaiRouteTabFromPath(ROUTES.KAI_HOME)).toBe("market");
  });

  it("resolves connect routes", () => {
    expect(activeKaiRouteTabFromPath(ROUTES.MARKETPLACE)).toBe("connect");
  });

  it("resolves dashboard routes", () => {
    expect(activeKaiRouteTabFromPath(ROUTES.KAI_DASHBOARD)).toBe(
      "dashboard",
    );
  });

  it("resolves analysis routes", () => {
    expect(activeKaiRouteTabFromPath(ROUTES.KAI_ANALYSIS)).toBe(
      "analysis",
    );
  });

  it("falls back to market for unknown paths", () => {
    expect(activeKaiRouteTabFromPath("/unknown")).toBe("market");
  });
});

describe("getAdjacentKaiRouteHref", () => {
  it("returns null for previous from first tab", () => {
    expect(
      getAdjacentKaiRouteHref(ROUTES.KAI_HOME, "prev"),
    ).toBeNull();
  });

  it("returns null for next from last tab", () => {
    expect(
      getAdjacentKaiRouteHref(ROUTES.KAI_ANALYSIS, "next"),
    ).toBeNull();
  });

  it("navigates market to dashboard", () => {
    expect(
      getAdjacentKaiRouteHref(ROUTES.KAI_HOME, "next"),
    ).toBe(ROUTES.KAI_DASHBOARD);
  });

  it("navigates dashboard to connect", () => {
    expect(
      getAdjacentKaiRouteHref(ROUTES.KAI_DASHBOARD, "next"),
    ).toBe(ROUTES.MARKETPLACE);
  });

  it("navigates connect to analysis", () => {
    const href = getAdjacentKaiRouteHref(
      ROUTES.MARKETPLACE,
      "next",
    );

    expect(href).toContain(ROUTES.KAI_ANALYSIS);
  });

  it("navigates analysis to connect", () => {
    expect(
      getAdjacentKaiRouteHref(ROUTES.KAI_ANALYSIS, "prev"),
    ).toBe(ROUTES.MARKETPLACE);
  });
});