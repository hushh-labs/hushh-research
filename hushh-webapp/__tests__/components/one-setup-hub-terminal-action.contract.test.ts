import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("One setup hub terminal action contract", () => {
  it("routes completed rows through their canonical setup entry", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    expect(source.match(/href=\{item\.copy\.href\}/g)).toHaveLength(2);
    // The route coordinator owns durable completion. The hub must not invent a
    // second target that would diverge for taps, voice navigation, or deep links.
    expect(source).not.toContain(
      "resolveCompletedSetupCapabilityEntry(item.id)",
    );
  });

  it("always finishes root setup through the required vault boundary", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    expect(source).toContain('const masterActionLabel = "Finish setup"');
    expect(source).toContain("isCapabilitySetupComplete(item.status)");
    expect(source).toContain('actionId="setup.hub_master_ack"');
    expect(source).toContain('variant="blue-gradient"');
    expect(source).toContain('effect="fill"');
    expect(source).toContain("FinanceSetupDraftService.finalizeForVault");
    expect(source.lastIndexOf("FinanceSetupDraftService.finalizeForVault")).toBeLessThan(
      source.indexOf("await acknowledgeOneSetupExit"),
    );
  });

  it("uses the same responsive in-flow terminal action as a capability workspace", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    expect(source).toContain("<SetupCompletionFooter");
    expect(source).toContain('testId="one-setup-master-ack"');
    expect(source).toContain("disabled={!runtimeChoiceComplete}");
    expect(source).toContain(
      "PreVaultUserStateService.hasOneRuntimeChoice(currentState)",
    );
    expect(source).toContain("<SetupCompletionFooter");
    expect(source).toContain("<div className={styles.flatChecklist}>");
    expect(source.indexOf("<SetupCompletionFooter")).toBeGreaterThan(
      source.indexOf("<div className={styles.flatChecklist}>"),
    );
    expect(source).not.toContain("actions={");
  });

  it("leaves fixed-chrome clearance to the shared app scroll root", () => {
    const styles = readFileSync(
      join(
        process.cwd(),
        "components/onboarding/setup/one-setup-hub.module.css",
      ),
      "utf8",
    );

    expect(styles).not.toContain(".setupShell");
    expect(styles).not.toContain("--app-bottom-inset");
  });

  it("keeps AI access with the remaining setup work instead of a separate private configuration section", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    expect(source).toContain('title="Remaining"');
    expect(source).toContain('title="AI access"');
    expect(source).toContain("<SetupNavigationTile");
    expect(source).toContain('voiceControlId="one_setup_tile_connections"');
    expect(source).not.toContain("Private configuration");
    expect(source.indexOf('title="AI access"')).toBeLessThan(
      source.indexOf("remainingItems.map"),
    );
  });

  it("counts the mandatory AI access choice in the same progress projection as capability rows", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    expect(source).toContain(
      'id: "connections", complete: runtimeChoiceComplete',
    );
    expect(source).toContain("const total = progressSteps.length");
    expect(source).toContain(
      "const done = progressSteps.filter((step) => step.complete).length",
    );
    expect(source).not.toContain("masterSkipped");
    expect(source).not.toContain("const total = items.length");
  });

  it("does not publish coarse setup sections before bootstrap and enrichment settle", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );
    const stateHook = readFileSync(
      join(process.cwd(), "lib/onboarding/use-capability-setup-states.ts"),
      "utf8",
    );

    expect(source).toContain("const hubStateLoading =");
    expect(source).toContain("isLoading || isEnriching");
    expect(source).toContain("<SetupHubLoadingState />");
    expect(source).not.toContain("<Skeleton");
    expect(source).toContain("Checking your setup choices");
    expect(source).toMatch(/actions:\s*hubStateLoading\s*\?\s*\[\]\s*:/);
    expect(stateHook).toContain("useState(enrichVault)");
    expect(stateHook).toContain("useState(enrichOauth)");
    expect(stateHook).toContain("useState(enrichRia)");
  });

  it("keeps the quiet Morphy action legible on hover and while disabled", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "components/onboarding/setup/setup-completion-footer.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("hover:!text-[var(--app-accent)]");
    expect(source).toContain("disabled:!text-muted-foreground");
    expect(source).toContain("disabled:!opacity-100");
  });

  it("prevents KYC setup settlement while its server preference is saving", () => {
    const emailSetup = readFileSync(
      join(
        process.cwd(),
        "app/one/setup/email/email-onboarding-setup-client.tsx",
      ),
      "utf8",
    );
    const coordinator = readFileSync(
      join(
        process.cwd(),
        "components/onboarding/setup/setup-capability-coordinator.tsx",
      ),
      "utf8",
    );

    expect(emailSetup).toContain("pending={saving}");
    expect(emailSetup).toContain("settlementBlocked: saving");
    expect(coordinator).toContain("if (pending) return");
    expect(coordinator).toContain("disabled={pending}");
    expect(coordinator).toMatch(
      /enabled:\s*enabled && routeReady && !settlementBlocked && !isAlreadyComplete/,
    );
  });

  it("never sends the master exit back onto a setup surface", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    // completionTarget must drop a `return_to` that resolves to a setup route
    // (e.g. ?return_to=/one/setup). Otherwise Skip/Finish replace()s the hub
    // with itself and looks like a no-op (regression #4630).
    expect(source).toContain("isOneSetupSurfaceRoute(path) ? null : raw");
  });

  it("surfaces the master action top-right on mobile and keeps the in-flow footer for desktop", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    // Mobile shows a reachable top-right Skip/Finish (the fixed agent bar would
    // cover a bottom footer on phones); desktop keeps the in-flow footer.
    expect(source).toContain('data-testid="one-setup-master-ack-mobile"');
    expect(source).toContain("sm:hidden");
    expect(source).toContain('<div className="hidden sm:block">');
  });

  it("requires vault completion after master setup acknowledgement", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    expect(source).toContain("setVaultInvitationOpen(true);");
    expect(source).toContain("const completeSetupAfterVault = useCallback(async ()");
    const masterHandler = source.slice(source.indexOf("const handleMasterAck"));
    expect(masterHandler).not.toContain("acknowledgeOneSetupExit");
    expect(source).toContain('data-testid="one-setup-vault-invitation"');
    expect(source).toContain("Set up private vault");
    expect(source).not.toContain("I’ll do this later");
    expect(source).not.toContain("one-setup-vault-invitation-later");
    expect(source).toContain("<VaultUnlockDialog");
    expect(source).toContain("dismissible={false}");
    expect(source).toContain("PreVaultSensitiveDraftService.finalizeForVault");
    expect(source).toContain("PostUnlockSyncService.run");
    expect(source).toContain("onSuccess={() => undefined}");
  });

  it("does not allow a setup route to create a first vault before Finish setup", () => {
    const vaultFreeSetupSurfaces = [
      "app/one/setup/email/email-onboarding-setup-client.tsx",
      "components/onboarding/setup/kyc-identity-preface.tsx",
      "app/one/setup/location/location-onboarding-setup-client.tsx",
    ];

    for (const relativePath of vaultFreeSetupSurfaces) {
      const source = readFileSync(join(process.cwd(), relativePath), "utf8");
      expect(source).not.toContain("VaultUnlockDialog");
      expect(source).not.toContain("CapabilityVaultPrerequisite");
    }

    const existingVaultOnlySurfaces = [
      "app/one/setup/kai/page.tsx",
      "app/one/setup/connected-systems/connected-systems-onboarding-setup-client.tsx",
    ];
    for (const relativePath of existingVaultOnlySurfaces) {
      const source = readFileSync(join(process.cwd(), relativePath), "utf8");
      expect(source).toContain("allowVaultCreation={false}");
    }
  });
});
