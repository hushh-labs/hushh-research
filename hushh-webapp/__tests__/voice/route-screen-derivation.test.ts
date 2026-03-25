import { describe, expect, it } from "vitest";

import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";

describe("deriveVoiceRouteScreen", () => {
  it("maps canonical portfolio route to dashboard screen", () => {
    expect(deriveVoiceRouteScreen("/kai/portfolio")).toEqual({
      screen: "dashboard",
      subview: null,
    });
  });

  it("keeps legacy dashboard compatibility mapping", () => {
    expect(deriveVoiceRouteScreen("/kai/dashboard/analysis")).toEqual({
      screen: "dashboard",
      subview: "analysis",
    });
  });

  it("maps profile and fallback routes", () => {
    expect(deriveVoiceRouteScreen("/profile")).toEqual({
      screen: "profile",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/unknown")).toEqual({
      screen: "app",
      subview: null,
    });
  });
});
