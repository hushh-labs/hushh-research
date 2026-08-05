import { describe, expect, it } from "vitest";

import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";

describe("deriveVoiceRouteScreen", () => {
  it("keeps the public One introduction distinct from authenticated One", () => {
    expect(deriveVoiceRouteScreen("/")).toEqual({
      screen: "one_intro",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one")).toEqual({
      screen: "one_agents",
      subview: null,
    });
  });

  it("maps the One Agents dashboard to an explicit voice screen", () => {
    expect(deriveVoiceRouteScreen("/one")).toEqual({
      screen: "one_agents",
      subview: null,
    });
  });

  it("maps canonical market and portfolio routes to richer Kai screens", () => {
    expect(deriveVoiceRouteScreen("/one/kai")).toEqual({
      screen: "kai_market",
      subview: "market",
    });
    expect(deriveVoiceRouteScreen("/one/kai/portfolio")).toEqual({
      screen: "kai_portfolio_dashboard",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one/kai/portfolio/holdings")).toEqual({
      screen: "kai_portfolio_holdings",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one/kai/portfolio/performance")).toEqual({
      screen: "kai_portfolio_performance",
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
    expect(deriveVoiceRouteScreen("/one/profile")).toEqual({
      screen: "profile_account",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/unknown")).toEqual({
      screen: "app",
      subview: null,
    });
  });

  it("maps One KYC to a voice-eligible screen", () => {
    expect(deriveVoiceRouteScreen("/one/kyc")).toEqual({
      screen: "one_kyc",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one/kyc", "panel=aliases")).toEqual({
      screen: "one_kyc",
      subview: "aliases",
    });
  });

  it("maps marketplace routes to generated action gateway screens", () => {
    expect(deriveVoiceRouteScreen("/one/marketplace")).toEqual({
      screen: "one_marketplace",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/marketplace")).toEqual({
      screen: "marketplace",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/marketplace/ria", "riaId=ria_123")).toEqual(
      {
        screen: "marketplace_ria_profile",
        subview: "profile",
      },
    );
  });

  it("preserves receipts, gmail, support, and retired Finance redirect context", () => {
    expect(deriveVoiceRouteScreen("/one/location")).toEqual({
      screen: "one_location",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one/location/map")).toEqual({
      screen: "one_location_map",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one/gmail")).toEqual({
      screen: "gmail",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one/pkm")).toEqual({
      screen: "pkm",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one/connected-systems")).toEqual({
      screen: "connected_systems",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one/profile/receipts")).toEqual({
      screen: "gmail",
      subview: "legacy",
    });
    expect(deriveVoiceRouteScreen("/one/profile/pkm")).toEqual({
      screen: "pkm",
      subview: "legacy",
    });
    expect(deriveVoiceRouteScreen("/one/profile/pkm-agent-lab")).toEqual({
      screen: "profile_pkm_agent_lab",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one/profile?panel=gmail")).toEqual({
      screen: "profile_gmail_panel",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one/profile/gmail/actions")).toEqual({
      screen: "profile_gmail_panel",
      subview: "actions",
    });
    expect(
      deriveVoiceRouteScreen("/one/profile?tab=account&panel=support"),
    ).toEqual({
      screen: "profile_support_panel",
      subview: "account",
    });
    expect(deriveVoiceRouteScreen("/one/profile/support/routing")).toEqual({
      screen: "profile_support_panel",
      subview: "routing",
    });
    expect(deriveVoiceRouteScreen("/one/profile/security/vault")).toEqual({
      screen: "profile_security_panel",
      subview: "vault",
    });
    expect(deriveVoiceRouteScreen("/one/profile/security/devices")).toEqual({
      screen: "profile_security_devices",
      subview: null,
    });
    expect(
      deriveVoiceRouteScreen("/one/profile/security/devices/authorize"),
    ).toEqual({
      screen: "app",
      subview: "trusted-device-authorization",
    });
    expect(deriveVoiceRouteScreen("/one/profile/regulatory")).toEqual({
      screen: "profile_regulatory",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one/kai/investments")).toEqual({
      screen: "kai_portfolio_dashboard",
      subview: "portfolio",
    });
    expect(deriveVoiceRouteScreen("/one/kai/funding-trade")).toEqual({
      screen: "kai_portfolio_dashboard",
      subview: "portfolio",
    });
  });

  it("accepts search params passed separately from the pathname", () => {
    expect(deriveVoiceRouteScreen("/one/profile", "panel=gmail")).toEqual({
      screen: "profile_gmail_panel",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one/profile", "tab=privacy")).toEqual({
      screen: "profile_privacy",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/one/profile", "panel=regulatory")).toEqual({
      screen: "profile_account",
      subview: null,
    });
  });

  it("maps RIA roster, workspace, and detail routes to specific voice screens", () => {
    expect(deriveVoiceRouteScreen("/ria/onboarding")).toEqual({
      screen: "ria_onboarding",
      subview: null,
    });
    expect(deriveVoiceRouteScreen("/ria/profile", "tab=services")).toEqual({
      screen: "profile_regulatory",
      subview: "services",
    });
    expect(deriveVoiceRouteScreen("/ria/clients")).toEqual({
      screen: "ria_clients",
      subview: null,
    });
    expect(
      deriveVoiceRouteScreen("/ria/clients/client-123", "tab=access"),
    ).toEqual({
      screen: "ria_client_workspace",
      subview: "access",
    });
    expect(
      deriveVoiceRouteScreen("/ria/clients/client-123/accounts/account-1"),
    ).toEqual({
      screen: "ria_client_account_detail",
      subview: null,
    });
    expect(
      deriveVoiceRouteScreen("/ria/clients/client-123/requests/request-1"),
    ).toEqual({
      screen: "ria_client_request_detail",
      subview: null,
    });
  });
});
