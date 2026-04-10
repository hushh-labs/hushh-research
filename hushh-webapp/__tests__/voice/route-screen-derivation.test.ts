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

  it("preserves receipts, gmail, support, and investments screen specificity", () => {
    expect(deriveVoiceRouteScreen("/profile/receipts")).toEqual({
      screen: "profile_receipts",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/profile?tab=account&panel=gmail")).toEqual({
      screen: "profile_gmail_panel",
      subview: "account",
    });
    expect(deriveVoiceRouteScreen("/profile?tab=account&panel=support")).toEqual({
      screen: "profile_support_panel",
      subview: "account",
    });
    expect(deriveVoiceRouteScreen("/kai/investments")).toEqual({
      screen: "kai_investments",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/kai/funding-trade")).toEqual({
      screen: "kai_funding_trade",
      subview: null,
    });
  });

  it("accepts search params passed separately from the pathname", () => {
    expect(deriveVoiceRouteScreen("/profile", "tab=account&panel=gmail")).toEqual({
      screen: "profile_gmail_panel",
      subview: "account",
    });
  });
});
