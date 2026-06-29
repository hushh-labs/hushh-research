import { describe, expect, it } from "vitest";

import {
  buildRiaClientAccountRoute,
  buildRiaClientRequestRoute,
  buildRiaClientWorkspaceRoute,
  buildOneSetupKaiRoute,
  buildOneSetupCapabilityRoute,
  isOneSetupCapabilityRoute,
  isOneSetupSurfaceRoute,
  isOneSetupWizardRoute,
  isOneSetupRoute,
  isPublicRoute,
  isRiaRoute,
  resolveCapabilityHandoffTarget,
  ROUTES,
} from "@/lib/navigation/routes";



describe("navigation routes", () => {
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
});
