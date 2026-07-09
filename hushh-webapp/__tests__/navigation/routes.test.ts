import { describe, expect, it } from "vitest";

import {
  buildRiaClientAccountRoute,
  buildRiaClientRequestRoute,
  buildRiaClientWorkspaceRoute,
  buildOneSetupKaiRoute,
  buildOneSetupCapabilityRoute,
  isCapabilityHandoffTarget,
  isOneSetupCapabilityRoute,
  isOneSetupSurfaceRoute,
  isOneSetupWizardRoute,
  isOneSetupRoute,
  isPublicRoute,
  isRiaRoute,
  resolveCapabilityHandoffTarget,
  ROUTES,
} from "@/lib/navigation/routes";
import {
  buildCanonicalProfileRouteFromLegacyQuery,
  buildProfileRoute,
  resolveProfileRouteState,
} from "@/lib/navigation/profile-routes";
import { getRouteScope, routePersonaForScope } from "@/lib/navigation/route-scope";



describe("navigation routes", () => {
  it("builds canonical nested profile routes while preserving transient query state", () => {
    const transient = new URLSearchParams({
      unlock_vault: "1",
      return_to: "/one/location/invite/token_123",
      panel: "security",
    });

    expect(buildProfileRoute({ panel: "account" })).toBe("/profile/account");
    expect(
      buildProfileRoute({ panel: "account", detail: "phone" }),
    ).toBe("/profile/account/phone");
    expect(
      buildProfileRoute({ panel: "preferences", detail: "kai-preferences" }),
    ).toBe("/profile/preferences/kai");
    expect(
      buildProfileRoute({ panel: "security", detail: "vault" }),
    ).toBe("/profile/security/vault");
    expect(
      buildProfileRoute({ panel: "my-data", detail: "domain:finance" }),
    ).toBe("/profile/my-data/domain?key=finance");
    expect(
      buildProfileRoute({ panel: "access", detail: "connection:abc 123" }),
    ).toBe("/profile/access/connection?id=abc+123");
    expect(
      buildProfileRoute({
        panel: "support",
        detail: "support-compose:bug_report",
      }),
    ).toBe("/profile/support/compose?kind=bug_report");
    expect(
      buildProfileRoute({ panel: "security", searchParams: transient }),
    ).toBe(
      "/profile/security?unlock_vault=1&return_to=%2Fone%2Flocation%2Finvite%2Ftoken_123",
    );
  });

  it("resolves nested and legacy profile route state through the same contract", () => {
    expect(resolveProfileRouteState("/profile/gmail/actions")).toEqual({
      panel: "gmail",
      detail: "gmail-actions",
    });
    expect(
      resolveProfileRouteState("/profile/my-data/domain", "key=finance"),
    ).toEqual({ panel: "my-data", detail: "domain:finance" });
    expect(
      resolveProfileRouteState("/profile", "tab=privacy&detail=connection:abc"),
    ).toEqual({ panel: "access", detail: "connection:abc" });
    expect(
      buildCanonicalProfileRouteFromLegacyQuery(
        "/profile",
        "panel=support&detail=support-routing",
      ),
    ).toBe("/profile/support/routing");
  });

  it("preserves query parameter integrity for ria workspace tabs", () => {
    expect(buildRiaClientWorkspaceRoute("client-123", { tab: "kai" })).toBe(
      "/ria/clients/client-123?tab=kai"
    );

    expect(buildRiaClientWorkspaceRoute("client 123", { tab: "access" })).toBe(
      "/ria/clients/client%20123?tab=access"
    );
  });

  it("preserves encoded route segments for ria account and request routes", () => {
    expect(buildRiaClientAccountRoute("client 123", "acct 456")).toBe(
      "/ria/clients/client%20123/accounts/acct%20456"
    );

    expect(buildRiaClientRequestRoute("client 123", "request 789")).toBe(
      "/ria/clients/client%20123/requests/request%20789"
    );
  });
    it("preserves public route classification stability", () => {
    expect(isPublicRoute("/")).toBe(true);
    expect(isPublicRoute("/developers")).toBe(true);
    expect(isPublicRoute("/login")).toBe(true);

    expect(isPublicRoute("/ria")).toBe(false);
    expect(isPublicRoute("/one")).toBe(false);
    expect(isPublicRoute("/one/kai")).toBe(false);
    expect(isPublicRoute("/kai")).toBe(false);
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

    expect(getRouteScope("/kai")).toBe("investor");
    expect(routePersonaForScope(getRouteScope("/kai"))).toBe("investor");
  });

  it("builds the kai setup wizard route with query parameters", () => {
    expect(buildOneSetupKaiRoute()).toBe("/one/setup/kai");
    expect(buildOneSetupKaiRoute({ from: "/one" })).toBe("/one/setup/kai?from=%2Fone");
  });

  it("treats the /one/setup hub as the canonical setup surface", () => {
    // The setup hub is the root setup surface; the wizard is a sub-step.
    expect(isOneSetupRoute("/one/setup")).toBe(true);
    expect(isOneSetupRoute("/one/setup/finance")).toBe(true);
    expect(isOneSetupRoute("/one/setup/kai")).toBe(true);
    expect(isOneSetupRoute("/one/onboarding")).toBe(false);
    expect(isOneSetupRoute("/one")).toBe(false);

    // The wizard predicate ONLY matches the canonical /one/setup/kai surface.
    expect(isOneSetupWizardRoute("/one/setup/kai")).toBe(true);
    expect(isOneSetupWizardRoute("/one/setup/kai/complete")).toBe(true);
    expect(isOneSetupWizardRoute("/one/setup")).toBe(false);
    // A per-capability step is NOT the wizard (so resolved users are not bounced).
    expect(isOneSetupWizardRoute("/one/setup/gmail")).toBe(false);

    // The broad setup-surface check spans the hub, the wizard, AND the
    // per-capability steps so the gate and chrome treat them as one surface.
    expect(isOneSetupSurfaceRoute("/one/setup")).toBe(true);
    expect(isOneSetupSurfaceRoute("/one/setup/kai")).toBe(true);
    expect(isOneSetupSurfaceRoute("/one/setup/gmail")).toBe(true);
    expect(isOneSetupSurfaceRoute("/one")).toBe(false);
    expect(isOneSetupSurfaceRoute("/one/kai")).toBe(false);
  });

  it("classifies per-capability setup step routes by known capability id", () => {
    expect(buildOneSetupCapabilityRoute("gmail")).toBe("/one/setup/gmail");
    expect(buildOneSetupCapabilityRoute("connected-systems")).toBe(
      "/one/setup/connected-systems",
    );

    // Known capabilities match.
    expect(isOneSetupCapabilityRoute("/one/setup/finance")).toBe(true);
    expect(isOneSetupCapabilityRoute("/one/setup/gmail")).toBe(true);
    expect(isOneSetupCapabilityRoute("/one/setup/email")).toBe(true);
    expect(isOneSetupCapabilityRoute("/one/setup/location")).toBe(true);
    expect(isOneSetupCapabilityRoute("/one/setup/pkm")).toBe(true);
    expect(isOneSetupCapabilityRoute("/one/setup/consent")).toBe(true);
    expect(isOneSetupCapabilityRoute("/one/setup/marketplace")).toBe(true);
    expect(isOneSetupCapabilityRoute("/one/setup/connected-systems")).toBe(true);

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
    expect(resolveCapabilityHandoffTarget("finance")).toBe(ROUTES.ONE_SETUP_KAI);
    expect(resolveCapabilityHandoffTarget("email")).toBe(ROUTES.ONE_KYC);
    expect(resolveCapabilityHandoffTarget("location")).toBe(ROUTES.ONE_LOCATION);
    expect(resolveCapabilityHandoffTarget("pkm")).toBe(ROUTES.PKM);
    expect(resolveCapabilityHandoffTarget("consent")).toBe(`${ROUTES.CONSENTS}?tab=pending`);
    expect(resolveCapabilityHandoffTarget("connected-systems")).toBe(
      ROUTES.CONNECTED_SYSTEMS,
    );
    expect(resolveCapabilityHandoffTarget("nope")).toBe(ROUTES.ONE_SETUP);
  });

  it("identifies hard-gated capability handoff targets (for the ?from=setup guard allow-through)", () => {
    // Hard-gated `/one/*` product surfaces: the guard must allow a
    // setup-originated (`?from=setup`) entry through without the master gate.
    expect(isCapabilityHandoffTarget(ROUTES.GMAIL)).toBe(true);
    expect(isCapabilityHandoffTarget(ROUTES.ONE_KYC)).toBe(true);
    expect(isCapabilityHandoffTarget(ROUTES.ONE_LOCATION)).toBe(true);
    expect(isCapabilityHandoffTarget(ROUTES.PKM)).toBe(true);
    expect(isCapabilityHandoffTarget(ROUTES.CONNECTED_SYSTEMS)).toBe(true);
    // Excluded: the finance wizard is a setup surface (already allow-listed),
    // consent lives off `/one/*` (not gated at all), and arbitrary routes and
    // the hub itself must NOT be treated as gated capability entries.
    expect(isCapabilityHandoffTarget(ROUTES.ONE_SETUP_KAI)).toBe(false);
    expect(isCapabilityHandoffTarget(`${ROUTES.CONSENTS}?tab=pending`)).toBe(
      false,
    );
    expect(isCapabilityHandoffTarget(ROUTES.CONSENTS)).toBe(false);
    expect(isCapabilityHandoffTarget(ROUTES.ONE_SETUP)).toBe(false);
    expect(isCapabilityHandoffTarget(ROUTES.ONE_HOME)).toBe(false);
    expect(isCapabilityHandoffTarget("/one/marketplace")).toBe(false);
  });
});
