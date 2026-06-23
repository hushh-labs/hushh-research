import { describe, expect, it } from "vitest";

import {
  ROUTES,
  buildConnectedSystemRoute,
  buildMarketplaceRiaProfileRoute,
  buildPhoneMandateRoute,
  buildMarketplaceConnectionsRoute,
  buildKaiAnalysisPreviewRoute,
  normalizeInternalRouteHref,
  resolveInternalRouteHref,
  isRiaOnboardingRoute,
  isRiaActionBarRoute,
} from "@/lib/navigation/routes";

describe("route builders", () => {
  it("buildConnectedSystemRoute returns base route when id is absent", () => {
    expect(buildConnectedSystemRoute()).toBe(ROUTES.CONNECTED_SYSTEMS);
  });

  it("buildConnectedSystemRoute appends an id", () => {
    expect(buildConnectedSystemRoute("sys-1")).toContain("sys-1");
  });

  it("buildMarketplaceRiaProfileRoute returns base route when id is absent", () => {
    expect(buildMarketplaceRiaProfileRoute()).toBe(
      ROUTES.MARKETPLACE_RIA_PROFILE,
    );
  });

  it("buildMarketplaceRiaProfileRoute appends a ria id", () => {
    expect(buildMarketplaceRiaProfileRoute("ria-1")).toContain("ria-1");
  });

  it("buildPhoneMandateRoute returns base route when redirect is absent", () => {
    expect(buildPhoneMandateRoute()).toBe(ROUTES.PHONE_MANDATE);
  });

  it("buildPhoneMandateRoute appends redirect information", () => {
    expect(buildPhoneMandateRoute("/one")).toContain("redirect=");
  });

  it("buildMarketplaceConnectionsRoute returns a route", () => {
    expect(buildMarketplaceConnectionsRoute()).toBe(ROUTES.CONSENTS);
  });

  it("buildKaiAnalysisPreviewRoute returns base route by default", () => {
    expect(buildKaiAnalysisPreviewRoute()).toBe(ROUTES.KAI_ANALYSIS);
  });

  it("buildKaiAnalysisPreviewRoute supports ticker values", () => {
    expect(
      buildKaiAnalysisPreviewRoute({ ticker: "AAPL" }),
    ).toContain("ticker=");
  });
});

describe("internal route helpers", () => {
  it("normalizeInternalRouteHref rejects invalid values", () => {
    expect(normalizeInternalRouteHref("")).toBeNull();
    expect(normalizeInternalRouteHref("https://example.com")).toBeNull();
  });

  it("normalizeInternalRouteHref accepts valid internal paths", () => {
    expect(normalizeInternalRouteHref("/one/kai")).toBe("/one/kai");
  });

  it("resolveInternalRouteHref falls back for invalid input", () => {
    expect(resolveInternalRouteHref("", ROUTES.HOME)).toBe(ROUTES.HOME);
  });

  it("resolveInternalRouteHref returns valid routes unchanged", () => {
    expect(resolveInternalRouteHref("/ria", ROUTES.HOME)).toBe("/ria");
  });
});

describe("ria route helpers", () => {
  it("recognizes ria onboarding routes", () => {
    expect(isRiaOnboardingRoute(ROUTES.RIA_ONBOARDING)).toBe(true);
  });

  it("does not treat normal ria routes as onboarding", () => {
    expect(isRiaOnboardingRoute(ROUTES.RIA_HOME)).toBe(false);
  });

  it("shows action bar for ria routes", () => {
    expect(isRiaActionBarRoute(ROUTES.RIA_HOME)).toBe(true);
  });

  it("hides action bar for ria onboarding routes", () => {
    expect(isRiaActionBarRoute(ROUTES.RIA_ONBOARDING)).toBe(false);
  });
});