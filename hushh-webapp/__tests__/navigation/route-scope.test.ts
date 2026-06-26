import { describe, expect, it } from "vitest";

import {
  getRouteScope,
  isPersonaScopedRoute,
  routePersonaForScope,
} from "@/lib/navigation/route-scope";

describe("route-scope", () => {
  it("classifies investor routes via exact and prefix match", () => {
    expect(getRouteScope("/one/kai")).toBe("investor");
    expect(getRouteScope("/one/kai/portfolio")).toBe("investor");
    expect(getRouteScope("/kai")).toBe("investor");
  });

  it("classifies ria routes via exact and prefix match", () => {
    expect(getRouteScope("/ria")).toBe("ria");
    expect(getRouteScope("/ria/clients/user-1")).toBe("ria");
  });

  it("classifies onboarding routes ahead of persona routes", () => {
    expect(getRouteScope("/one/onboarding")).toBe("onboarding");
    expect(getRouteScope("/kai/onboarding")).toBe("onboarding");
    expect(getRouteScope("/ria/onboarding")).toBe("onboarding");
  });

  it("classifies shared routes", () => {
    expect(getRouteScope("/")).toBe("shared");
    expect(getRouteScope("/one")).toBe("shared");
    expect(getRouteScope("/agent")).toBe("shared");
    expect(getRouteScope("/consents")).toBe("shared");
    expect(getRouteScope("/marketplace")).toBe("shared");
    expect(getRouteScope("/profile")).toBe("shared");
    expect(getRouteScope("/one/location")).toBe("shared");
  });

  it("classifies public routes", () => {
    expect(getRouteScope("/login")).toBe("public");
    expect(getRouteScope("/logout")).toBe("public");
  });

  it("returns unknown for empty and unrecognized paths", () => {
    expect(getRouteScope("")).toBe("unknown");
    expect(getRouteScope("/some-random-path")).toBe("unknown");
  });

  it("flags only investor and ria routes as persona scoped", () => {
    expect(isPersonaScopedRoute("/one/kai")).toBe(true);
    expect(isPersonaScopedRoute("/ria")).toBe(true);
    expect(isPersonaScopedRoute("/")).toBe(false);
  });

  it("maps persona scopes correctly", () => {
    expect(routePersonaForScope("investor")).toBe("investor");
    expect(routePersonaForScope("ria")).toBe("ria");
  });
});