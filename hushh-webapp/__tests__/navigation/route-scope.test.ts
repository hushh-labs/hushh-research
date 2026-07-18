import { describe, expect, it } from "vitest";

import {
  getRouteScope,
  isPersonaScopedRoute,
  routePersonaForScope,
} from "@/lib/navigation/route-scope";
import { ROUTES } from "@/lib/navigation/routes";

describe("getRouteScope", () => {
  it("resolves onboarding routes", () => {
    expect(getRouteScope(ROUTES.ONE_ONBOARDING)).toBe("onboarding");
    expect(getRouteScope(ROUTES.RIA_ONBOARDING)).toBe("onboarding");
  });

  it("resolves investor routes", () => {
    expect(getRouteScope(ROUTES.KAI_HOME)).toBe("investor");
    expect(getRouteScope(ROUTES.KAI_DASHBOARD)).toBe("investor");
  });

  it("resolves ria routes", () => {
    expect(getRouteScope(ROUTES.RIA_HOME)).toBe("ria");
    expect(getRouteScope(ROUTES.RIA_CLIENTS)).toBe("ria");
  });

  it("resolves shared routes", () => {
    expect(getRouteScope(ROUTES.HOME)).toBe("shared");
    expect(getRouteScope(ROUTES.MARKETPLACE)).toBe("shared");
  });

  it("resolves public routes", () => {
    expect(getRouteScope(ROUTES.LOGIN)).toBe("public");
    expect(getRouteScope(ROUTES.LOGOUT)).toBe("public");
  });

  it("returns unknown for unsupported paths", () => {
    expect(getRouteScope("")).toBe("unknown");
    expect(getRouteScope("/developers")).toBe("unknown");
  });
});

describe("isPersonaScopedRoute", () => {
  it("returns true for investor routes", () => {
    expect(isPersonaScopedRoute(ROUTES.KAI_HOME)).toBe(true);
  });

  it("returns true for ria routes", () => {
    expect(isPersonaScopedRoute(ROUTES.RIA_HOME)).toBe(true);
  });

  it("returns false for shared routes", () => {
    expect(isPersonaScopedRoute(ROUTES.MARKETPLACE)).toBe(false);
  });

  it("returns false for onboarding routes", () => {
    expect(isPersonaScopedRoute(ROUTES.ONE_ONBOARDING)).toBe(false);
  });

  it("returns false for public routes", () => {
    expect(isPersonaScopedRoute(ROUTES.LOGIN)).toBe(false);
  });

  it("returns false for unknown routes", () => {
    expect(isPersonaScopedRoute("/developers")).toBe(false);
  });
});

describe("routePersonaForScope", () => {
  it("maps investor scope", () => {
    expect(routePersonaForScope("investor")).toBe("investor");
  });

  it("maps ria scope", () => {
    expect(routePersonaForScope("ria")).toBe("ria");
  });

  it("returns null for non-persona scopes", () => {
    expect(routePersonaForScope("shared")).toBeNull();
    expect(routePersonaForScope("onboarding")).toBeNull();
    expect(routePersonaForScope("public")).toBeNull();
    expect(routePersonaForScope("unknown")).toBeNull();
  });
});