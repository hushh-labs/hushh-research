import { describe, expect, it } from "vitest";

import {
  buildRiaClientAccountRoute,
  buildRiaClientRequestRoute,
  buildRiaClientWorkspaceRoute,
  buildConnectedSystemRoute,
  buildKaiMarketRoute,
  buildOneSetupKaiRoute,
  buildOneSetupCapabilityRoute,
  buildPersonProfileRoute,
  buildWelcomeRoute,
  isAnalyticsExemptRoute,
  isCapabilityHandoffTarget,
  isCompletedLocationWorkspaceRoute,
  isOnboardingAdmissionExemptRoute,
  isOneSetupCapabilityRoute,
  isOneSetupNavigationRoute,
  isOneSetupSurfaceRoute,
  isOneSetupWizardRoute,
  isOneSetupRoute,
  isPublicRoute,
  isRiaRoute,
  resolveCapabilityHandoffTarget,
  resolveCompletedSetupCapabilityEntry,
  resolvePersonRefFromProfilePathname,
  ROUTES,
} from "@/lib/navigation/routes";
import {
  buildCanonicalProfileRouteFromLegacyQuery,
  buildProfileRoute,
  resolveProfileRouteState,
} from "@/lib/navigation/profile-routes";
import {
  getRouteScope,
  routePersonaForScope,
} from "@/lib/navigation/route-scope";

describe("navigation routes", () => {
  it("builds Finance URLs with one explicit canonical tab", () => {
    expect(buildKaiMarketRoute("market")).toBe("/one/kai?tab=market");
    expect(buildKaiMarketRoute("analysis", { ticker: "AAPL" })).toBe(
      "/one/kai?tab=analysis&ticker=AAPL",
    );
    expect(buildKaiMarketRoute("portfolio", { tab: "analysis" })).toBe(
      "/one/kai?tab=portfolio",
    );
  });

  it("uses the canonical nested route for a selected CRM", () => {
    expect(buildConnectedSystemRoute("customer crm")).toBe(
      "/one/connected-systems/customer%20crm",
    );
    expect(
      buildConnectedSystemRoute("customer-crm", { agentActionId: "crm_123" }),
    ).toBe("/one/connected-systems/customer-crm?agentActionId=crm_123");
  });

  it("returns Login to the canonical welcome parent without accepting an external redirect", () => {
    expect(buildWelcomeRoute()).toBe(ROUTES.HOME);
    expect(buildWelcomeRoute(ROUTES.ONE_SETUP)).toBe(
      "/?redirect=%2Fone%2Fsetup",
    );
    expect(buildWelcomeRoute("https://example.com")).toBe(ROUTES.HOME);
    expect(buildWelcomeRoute("//example.com")).toBe(ROUTES.HOME);
  });

  it("builds person profile routes with a safe origin marker", () => {
    expect(
      buildPersonProfileRoute("public person/ref", { from: ROUTES.CONNECT }),
    ).toBe("/people/public%20person%2Fref?from=%2Fone%2Fconnect");
    expect(
      buildPersonProfileRoute("public-person-ref", {
        from: "https://example.com/one/connect",
      }),
    ).toBe("/people/public-person-ref");
    expect(buildPersonProfileRoute("public-person-ref")).toBe(
      "/people/public-person-ref",
    );
  });

  it("resolves the active person ref from public profile pathnames", () => {
    expect(resolvePersonRefFromProfilePathname("/people/public-person-ref")).toBe(
      "public-person-ref",
    );
    expect(
      resolvePersonRefFromProfilePathname(
        "/people/public%20person%2Fref?from=%2Fone%2Fconnect",
      ),
    ).toBe("public person/ref");
    expect(resolvePersonRefFromProfilePathname("/one/profile/access")).toBeNull();
  });

  it("builds canonical nested profile routes while preserving transient query state", () => {
    const transient = new URLSearchParams({
      unlock_vault: "1",
      return_to: "/one/location/invite/token_123",
      panel: "security",
    });

    expect(buildProfileRoute({ panel: "account" })).toBe(
      "/one/profile/account",
    );
    expect(buildProfileRoute({ panel: "account", detail: "phone" })).toBe(
      "/one/profile/account/phone",
    );
    expect(
      buildProfileRoute({ panel: "preferences", detail: "kai-preferences" }),
    ).toBe("/one/profile/preferences/kai");
    expect(buildProfileRoute({ panel: "preferences", detail: "gemini" })).toBe(
      "/one/profile/preferences/gemini",
    );
    expect(buildProfileRoute({ panel: "security", detail: "vault" })).toBe(
      "/one/profile/security/vault",
    );
    expect(
      buildProfileRoute({ panel: "my-data", detail: "domain:finance" }),
    ).toBe("/one/profile/my-data/domain?key=finance");
    // Sharing and its per-connection detail are sub-views of the unified Memory
    // panel but keep the legacy /one/profile/access URLs for deep-link parity.
    expect(
      buildProfileRoute({ panel: "my-data", detail: "connection:abc 123" }),
    ).toBe("/one/profile/access/connection?id=abc+123");
    expect(buildProfileRoute({ panel: "my-data", detail: "sharing" })).toBe(
      "/one/profile/access",
    );
    expect(
      buildProfileRoute({
        panel: "support",
        detail: "support-compose:bug_report",
      }),
    ).toBe("/one/profile/support/compose?kind=bug_report");
    expect(buildProfileRoute({ panel: "gmail" })).toBe("/one/gmail");
    expect(
      buildProfileRoute({
        panel: "gmail",
        detail: "gmail-actions",
        searchParams: transient,
      }),
    ).toBe(
      "/one/gmail?unlock_vault=1&return_to=%2Fone%2Flocation%2Finvite%2Ftoken_123",
    );
    expect(
      buildProfileRoute({ panel: "security", searchParams: transient }),
    ).toBe(
      "/one/profile/security?unlock_vault=1&return_to=%2Fone%2Flocation%2Finvite%2Ftoken_123",
    );
  });

  it("resolves nested and legacy profile route state through the same contract", () => {
    expect(resolveProfileRouteState("/one/profile/gmail/actions")).toEqual({
      panel: "gmail",
      detail: "gmail-actions",
    });
    expect(
      resolveProfileRouteState("/one/profile/my-data/domain", "key=finance"),
    ).toEqual({ panel: "my-data", detail: "domain:finance" });
    expect(
      resolveProfileRouteState(
        "/one/profile",
        "tab=privacy&detail=connection:abc",
      ),
    ).toEqual({ panel: "my-data", detail: "connection:abc" });
    expect(resolveProfileRouteState("/one/profile/access")).toEqual({
      panel: "my-data",
      detail: "sharing",
    });
    expect(
      resolveProfileRouteState("/one/profile/access/connection", "id=abc"),
    ).toEqual({ panel: "my-data", detail: "connection:abc" });
    expect(resolveProfileRouteState("/one/profile/regulatory")).toEqual({
      panel: null,
      detail: null,
    });
    expect(
      buildCanonicalProfileRouteFromLegacyQuery(
        "/one/profile",
        "panel=support&detail=support-routing",
      ),
    ).toBe("/one/profile/support/routing");
    expect(
      buildCanonicalProfileRouteFromLegacyQuery(
        "/one/profile",
        "panel=regulatory",
      ),
    ).toBe("/one/profile");
    expect(
      buildCanonicalProfileRouteFromLegacyQuery(
        "/one/profile",
        "panel=gmail&detail=gmail-actions",
      ),
    ).toBe("/one/gmail");
  });

  it("preserves query parameter integrity for ria workspace tabs", () => {
    expect(buildRiaClientWorkspaceRoute("client-123", { tab: "kai" })).toBe(
      "/ria/clients/client-123?tab=kai",
    );

    expect(buildRiaClientWorkspaceRoute("client 123", { tab: "access" })).toBe(
      "/ria/clients/client%20123?tab=access",
    );
  });

  it("preserves encoded route segments for ria account and request routes", () => {
    expect(buildRiaClientAccountRoute("client 123", "acct 456")).toBe(
      "/ria/clients/client%20123/accounts/acct%20456",
    );

    expect(buildRiaClientRequestRoute("client 123", "request 789")).toBe(
      "/ria/clients/client%20123/requests/request%20789",
    );
  });
  it("preserves public route classification stability", () => {
    expect(isPublicRoute("/")).toBe(true);
    expect(isPublicRoute("/welcome")).toBe(true);
    expect(isPublicRoute("/developers")).toBe(true);
    expect(isPublicRoute("/login")).toBe(true);

    expect(isPublicRoute("/ria")).toBe(false);
    expect(isPublicRoute("/one")).toBe(false);
    expect(isPublicRoute("/one/kai")).toBe(false);
    expect(isPublicRoute("/kai")).toBe(false);
    expect(isPublicRoute("/one/profile")).toBe(false);
    expect(isPublicRoute("/one/connect")).toBe(false);
  });

  it("exempts the public Wallet Profile from analytics without widening the exemption", () => {
    // A visitor scanning a stranger's QR is not our user and never agreed to
    // anything with us (Wallet Profile contract §7).
    expect(isAnalyticsExemptRoute("/c/abc123")).toBe(true);
    expect(isAnalyticsExemptRoute("/c")).toBe(true);
    // Capacitor's static export shapes: trailing slash and backing document.
    expect(isAnalyticsExemptRoute("/c/abc123/")).toBe(true);
    expect(isAnalyticsExemptRoute("/c/abc123/index.html")).toBe(true);

    // Strictly narrower than isPublicRoute: the marketing and auth surfaces
    // there are ours to instrument, and the owner's own Wallet Profile screen
    // is an authenticated product surface.
    expect(isAnalyticsExemptRoute("/")).toBe(false);
    expect(isAnalyticsExemptRoute("/welcome")).toBe(false);
    expect(isAnalyticsExemptRoute("/developers")).toBe(false);
    expect(isAnalyticsExemptRoute("/one/wallet-card")).toBe(false);
    expect(isAnalyticsExemptRoute("/one")).toBe(false);
    // Prefix matching must not spill into an unrelated sibling route.
    expect(isAnalyticsExemptRoute("/consents")).toBe(false);
    expect(isAnalyticsExemptRoute("/careers")).toBe(false);
  });

  it("defines profile and Connect inside the vault-protected One route family", () => {
    expect(ROUTES.PROFILE).toBe("/one/profile");
    expect(ROUTES.PROFILE_SECURITY).toBe("/one/profile/security");
    expect(ROUTES.PERSON_PROFILE).toBe("/people/[personRef]");
    expect(ROUTES.CONNECT).toBe("/one/connect");
    expect(ROUTES.CONNECT_SETTINGS).toBe("/one/connect/settings");
    expect(isOnboardingAdmissionExemptRoute(ROUTES.PROFILE)).toBe(true);
    expect(isOnboardingAdmissionExemptRoute(ROUTES.PROFILE_SECURITY)).toBe(
      true,
    );
    expect(isOnboardingAdmissionExemptRoute("/people/person-ref-scoped")).toBe(
      true,
    );
  });

  it("exempts the Circle join landing from onboarding admission (#5307)", () => {
    // An entry point from outside the app, like /login: the destination is
    // the reason the person opened the app, so a mid-setup user must still
    // see the invitation instead of being bounced to /one/setup with the
    // code dropped.
    expect(ROUTES.CIRCLE_JOIN).toBe("/circle/join");
    expect(isOnboardingAdmissionExemptRoute(ROUTES.CIRCLE_JOIN)).toBe(true);
    // The destination it hands off to once a code is accepted stays gated.
    expect(isOnboardingAdmissionExemptRoute(ROUTES.ONE_LOCATION)).toBe(false);
  });

  it("preserves ria route classification for nested workspace paths", () => {
    expect(isRiaRoute("/ria")).toBe(true);
    expect(isRiaRoute("/ria/clients")).toBe(true);
    expect(isRiaRoute("/ria/clients/client-123")).toBe(true);

    expect(isRiaRoute("/one/kai")).toBe(false);
  });

  it("keeps canonical One finance routes shared while legacy Kai routes stay investor-scoped", () => {
    expect(getRouteScope("/one/kai")).toBe("shared");
    expect(getRouteScope("/one/kai/analysis")).toBe("shared");
    expect(routePersonaForScope(getRouteScope("/one/kai/analysis"))).toBeNull();

    expect(getRouteScope("/kai")).toBe("shared");
    expect(routePersonaForScope(getRouteScope("/kai"))).toBeNull();
  });

  it("builds the kai setup wizard route with query parameters", () => {
    expect(buildOneSetupKaiRoute()).toBe("/one/setup/finance");
    expect(buildOneSetupKaiRoute({ from: "/one" })).toBe(
      "/one/setup/finance?from=%2Fone",
    );
  });

  it("treats the /one/setup hub as the canonical setup surface", () => {
    // The setup hub is the root setup surface; the wizard is a sub-step.
    expect(isOneSetupRoute("/one/setup")).toBe(true);
    expect(isOneSetupRoute("/one/setup/")).toBe(true);
    expect(isOneSetupRoute("/one/setup/index.html")).toBe(true);
    expect(isOneSetupRoute("/one/setup/finance")).toBe(false);
    expect(isOneSetupRoute("/one/setup/kai")).toBe(false);
    expect(isOneSetupRoute("/one/onboarding")).toBe(false);
    expect(isOneSetupRoute("/one")).toBe(false);

    // The wizard predicate matches the canonical Finance setup surface.
    expect(isOneSetupWizardRoute("/one/setup/finance")).toBe(true);
    expect(isOneSetupWizardRoute("/one/setup/finance/")).toBe(true);
    expect(isOneSetupWizardRoute("/one/setup/finance/import")).toBe(true);
    expect(isOneSetupWizardRoute("/one/setup/kai")).toBe(true);
    expect(isOneSetupWizardRoute("/one/setup/kai/complete")).toBe(false);
    expect(isOneSetupWizardRoute("/one/setup")).toBe(false);
    // A per-capability step is NOT the wizard (so resolved users are not bounced).
    expect(isOneSetupWizardRoute("/one/setup/gmail")).toBe(false);

    // The broad setup-surface check spans the hub, the wizard, AND the
    // per-capability steps so the gate and chrome treat them as one surface.
    expect(isOneSetupSurfaceRoute("/one/setup")).toBe(true);
    expect(isOneSetupSurfaceRoute("/one/setup/kai")).toBe(true);
    expect(isOneSetupSurfaceRoute("/one/setup/gmail")).toBe(true);
    expect(isOneSetupSurfaceRoute("/one/setup/gmail/")).toBe(true);
    expect(isOneSetupSurfaceRoute("/one/setup/connections")).toBe(true);
    expect(isOneSetupSurfaceRoute("/one/setup/connections/")).toBe(true);
    expect(isOneSetupSurfaceRoute("/one/setup/connections/index.html")).toBe(
      true,
    );
    expect(isOneSetupSurfaceRoute("/one")).toBe(false);
    expect(isOneSetupSurfaceRoute("/one/kai")).toBe(false);
  });

  it("classifies per-capability setup step routes by known capability id", () => {
    expect(buildOneSetupCapabilityRoute("gmail")).toBe("/one/setup/gmail");
    expect(buildOneSetupCapabilityRoute("connected-systems")).toBe(
      "/one/setup/connected-systems",
    );

    // Known capabilities match.
    expect(isOneSetupCapabilityRoute("/one/setup/gmail")).toBe(true);
    expect(isOneSetupCapabilityRoute("/one/setup/location")).toBe(true);
    expect(isOneSetupCapabilityRoute("/one/setup/email")).toBe(true);
    expect(isOneSetupCapabilityRoute("/one/setup/finance")).toBe(true);
    expect(isOneSetupCapabilityRoute("/one/setup/ria")).toBe(true);
    expect(isOneSetupCapabilityRoute("/one/setup/connected-systems")).toBe(
      true,
    );
    expect(isOneSetupCapabilityRoute("/one/setup/connections")).toBe(false);
    expect(isOneSetupNavigationRoute("/one/setup/connections")).toBe(true);
    expect(isOneSetupNavigationRoute("/one/setup/connections/")).toBe(true);

    // Retired setup-only ids remain ordinary product surfaces, not account
    // setup routes.
    expect(isOneSetupCapabilityRoute("/one/setup/pkm")).toBe(false);
    expect(isOneSetupCapabilityRoute("/one/setup/consent")).toBe(false);
    expect(isOneSetupCapabilityRoute("/one/setup/marketplace")).toBe(false);

    // Unknown segments and the bare hub/wizard are NOT capability routes.
    expect(isOneSetupCapabilityRoute("/one/setup")).toBe(false);
    expect(isOneSetupCapabilityRoute("/one/setup/kai")).toBe(false);
    expect(isOneSetupCapabilityRoute("/one/setup/gmail/extra")).toBe(false);
  });

  it("resolves per-capability handoff targets, containing unknown ids to the hub", () => {
    expect(resolveCapabilityHandoffTarget("gmail")).toBe(ROUTES.GMAIL);
    // Finance forwards into the investor-preferences WIZARD (questionnaire ->
    // persona -> portfolio import), not straight to the dashboard, so the
    // first-time finance journey is never orphaned from its setup steps.
    expect(resolveCapabilityHandoffTarget("finance")).toBe(ROUTES.KAI_HOME);
    expect(resolveCapabilityHandoffTarget("email")).toBe(ROUTES.ONE_KYC);
    expect(resolveCapabilityHandoffTarget("location")).toBe(
      ROUTES.ONE_LOCATION,
    );
    expect(resolveCapabilityHandoffTarget("ria")).toBe(ROUTES.RIA_ONBOARDING);
    expect(resolveCapabilityHandoffTarget("connected-systems")).toBe(
      ROUTES.CONNECTED_SYSTEMS,
    );
    expect(resolveCapabilityHandoffTarget("pkm")).toBe(ROUTES.ONE_SETUP);
    expect(resolveCapabilityHandoffTarget("consent")).toBe(ROUTES.ONE_SETUP);
    expect(resolveCapabilityHandoffTarget("marketplace")).toBe(
      ROUTES.ONE_SETUP,
    );
    expect(resolveCapabilityHandoffTarget("nope")).toBe(ROUTES.ONE_SETUP);
  });

  it("does not admit normal product routes while root setup is unresolved", () => {
    expect(isCapabilityHandoffTarget(ROUTES.GMAIL)).toBe(false);
    expect(isCapabilityHandoffTarget(ROUTES.ONE_KYC)).toBe(false);
    expect(isCapabilityHandoffTarget(ROUTES.ONE_LOCATION)).toBe(false);
    expect(isCapabilityHandoffTarget(ROUTES.CONNECTED_SYSTEMS)).toBe(false);
    expect(isCapabilityHandoffTarget(ROUTES.ONE_SETUP_FINANCE)).toBe(false);
    expect(isCapabilityHandoffTarget(ROUTES.RIA_ONBOARDING)).toBe(false);
    expect(isCapabilityHandoffTarget(ROUTES.CONSENTS)).toBe(false);
    expect(isCapabilityHandoffTarget(ROUTES.ONE_SETUP)).toBe(false);
    expect(isCapabilityHandoffTarget(ROUTES.ONE_HOME)).toBe(false);
    expect(isCapabilityHandoffTarget("/one/marketplace")).toBe(false);
  });

  it("admits only completed capability workspaces", () => {
    expect(
      isCompletedLocationWorkspaceRoute(["location"], "/one/location"),
    ).toBe(true);
    expect(
      isCompletedLocationWorkspaceRoute(
        ["location"],
        "/one/location/index.html",
      ),
    ).toBe(true);
    expect(
      isCompletedLocationWorkspaceRoute(["location"], "/one/location/invite"),
    ).toBe(true);
    expect(isCompletedLocationWorkspaceRoute(["gmail"], "/one/location")).toBe(
      false,
    );
    expect(
      isCompletedLocationWorkspaceRoute(["unknown"], "/one/location"),
    ).toBe(false);
    expect(isCompletedLocationWorkspaceRoute([], "/one/location")).toBe(false);
    expect(isCompletedLocationWorkspaceRoute(["gmail"], "/one/gmail")).toBe(
      false,
    );
  });

  it("acknowledges completed Location while root setup is still active", () => {
    expect(
      resolveCompletedSetupCapabilityEntry({
        capabilityId: "location",
        completedCapabilityIds: ["location"],
        rootSetupResolved: false,
      }),
    ).toEqual({ kind: "acknowledge", target: "/one/setup" });
    expect(
      resolveCompletedSetupCapabilityEntry({
        capabilityId: "location",
        completedCapabilityIds: [],
        rootSetupResolved: true,
      }),
    ).toEqual({ kind: "continue" });
    expect(
      resolveCompletedSetupCapabilityEntry({
        capabilityId: "location",
        completedCapabilityIds: ["location"],
        rootSetupResolved: true,
      }),
    ).toEqual({ kind: "redirect", target: "/one/location" });
    expect(
      resolveCompletedSetupCapabilityEntry({
        capabilityId: "gmail",
        completedCapabilityIds: ["gmail"],
        rootSetupResolved: true,
      }),
    ).toEqual({ kind: "continue" });
  });
});
