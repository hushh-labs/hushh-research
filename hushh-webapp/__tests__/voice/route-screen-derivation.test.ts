import { describe, expect, it } from "vitest";

import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";

describe("deriveVoiceRouteScreen", () => {
  it("maps canonical market and portfolio routes to richer Kai screens", () => {
    expect(deriveVoiceRouteScreen("/kai")).toEqual({
      screen: "kai_market",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/kai/portfolio")).toEqual({
      screen: "kai_portfolio_dashboard",
      subview: null,
    });
  });

  it("keeps legacy dashboard compatibility mapping", () => {
    expect(deriveVoiceRouteScreen("/kai/dashboard/analysis")).toEqual({
      screen: "kai_portfolio_dashboard",
      subview: "analysis",
    });
  });

  it("maps profile and fallback routes", () => {
    expect(deriveVoiceRouteScreen("/profile")).toEqual({
      screen: "profile_account",
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
    expect(deriveVoiceRouteScreen("/profile/pkm-agent-lab")).toEqual({
      screen: "profile_pkm_agent_lab",
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
    expect(deriveVoiceRouteScreen("/profile", "tab=privacy")).toEqual({
      screen: "profile_privacy",
      subview: null,
    });
  });
});
