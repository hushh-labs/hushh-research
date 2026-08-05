import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../../../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Location setup route contract", () => {
  it("runs the authored Location journey in explicit setup mode", () => {
    const adapter = read(
      "app/one/setup/location/location-onboarding-setup-client.tsx",
    );

    // Setup owns settlement while the shared Location surface owns permission
    // adapters and the canonical introduction. It must not fall through to the
    // normal workspace or reuse that workspace's persisted first-run flag.
    expect(adapter).toContain("<OneLocationAgentPage");
    expect(adapter).toContain('mode="setup"');
    expect(adapter).toContain(".finish({ suppressErrorToast: true })");
    expect(adapter).toContain(".skip({ suppressErrorToast: true })");
    expect(adapter).toContain('terminalPresentation: "automatic"');
    expect(adapter).not.toContain("vaultPrerequisiteRouteKey");
    expect(adapter).not.toContain("CapabilityVaultPrerequisite");
    expect(adapter).not.toContain("<SetupCapabilityTerminalFooter");
  });

  it("keeps Location setup vault-free until the root setup completion", () => {
    const locationPage = read("app/one/location/page.tsx");

    expect(locationPage).toContain('mode !== "setup"');
    expect(locationPage).toContain(
      'Boolean(auth.userId && (mode === "setup" || vaultOwnerToken))',
    );
    expect(locationPage).toContain(
      "onLocationReady={promptSaveLocationDuringOnboarding}",
    );
    expect(locationPage).toContain(
      "PreVaultSensitiveDraftService.stageSavedLocation(auth.userId, input)",
    );
    expect(locationPage).toContain(
      "deferredUntilVault={!vaultKey || !vaultOwnerToken}",
    );
    expect(locationPage).toContain(
      "vaultOwnerToken ? reverseGeocodeForSavedLocation : undefined",
    );
    expect(locationPage).not.toContain(
      'mode === "setup"\n              ? async () => true',
    );
  });

  it("settles completed Location before its onboarding body can mount", () => {
    const coordinator = read(
      "components/onboarding/setup/setup-capability-coordinator.tsx",
    );
    const adapter = read(
      "app/one/setup/location/location-onboarding-setup-client.tsx",
    );

    expect(coordinator).toContain(
      "completedCapabilityIds: initialJourney.setupCapabilityIds",
    );
    expect(coordinator).toContain("resolveCompletedSetupCapabilityEntry({");
    expect(coordinator).toContain('completedEntry.kind === "acknowledge"');
    expect(coordinator).toContain("setConfirmedCompletionKey(`${userId}:${capabilityId}`)");
    expect(coordinator).toContain(
      "enabled && routeReady && !settlementBlocked && !isAlreadyComplete",
    );
    expect(adapter).toContain("if (coordinator.isAlreadyComplete)");
    expect(adapter).toContain("<LocationOnboardingCompletedScreen");
    expect(adapter.indexOf("if (coordinator.isAlreadyComplete)")).toBeLessThan(
      adapter.indexOf("<CapabilityCinematicIntroGate"),
    );
  });
});
