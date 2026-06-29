import { describe, expect, it } from "vitest";

import { resolveAppRouteLayoutMode } from "@/lib/navigation/app-route-layout";

describe("resolveAppRouteLayoutMode", () => {
  it("returns hidden mode for hidden routes", () => {
    expect(resolveAppRouteLayoutMode("/login")).toBe(
      "hidden",
    );
  });

  it("returns flow mode for onboarding routes", () => {
    expect(
      resolveAppRouteLayoutMode("/one/onboarding"),
    ).toBe("flow");
  });

  it("returns redirect mode for redirect routes", () => {
    expect(resolveAppRouteLayoutMode("/gmail")).toBe(
      "redirect",
    );
  });

  it("returns standard mode for application routes", () => {
    expect(resolveAppRouteLayoutMode("/one")).toBe(
      "standard",
    );
  });

  it("matches dynamic route segments", () => {
    expect(
      resolveAppRouteLayoutMode(
        "/ria/clients/user-123",
      ),
    ).toBe("standard");
  });

  it("strips query strings before matching", () => {
    expect(
      resolveAppRouteLayoutMode(
        "/login?redirect=%2Fone",
      ),
    ).toBe("hidden");
  });

  it("strips hash fragments before matching", () => {
    expect(
      resolveAppRouteLayoutMode(
        "/ria/onboarding#step-2",
      ),
    ).toBe("flow");
  });

  it("falls back to standard mode for unknown routes", () => {
    expect(
      resolveAppRouteLayoutMode(
        "/no-such-route-anywhere",
      ),
    ).toBe("standard");
  });
});