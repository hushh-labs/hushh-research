import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("One setup hub terminal action contract", () => {
  it("always finishes root setup through the required vault boundary", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    expect(source).toContain('const masterActionLabel = "Finish setup"');
    expect(source).toContain('data-voice-action-id="setup.hub_master_ack"');
    expect(source).toContain('variant="blue"');
    expect(source).toContain('effect="fill"');
    expect(source).toContain("FinanceSetupDraftService.finalizeForVault");
    expect(source.lastIndexOf("FinanceSetupDraftService.finalizeForVault")).toBeLessThan(
      source.indexOf("await acknowledgeOneSetupExit"),
    );
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


  it("marks the one mandatory row as required rather than leaving it a quiet grey status", () => {
    const hub = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );
    const tile = readFileSync(
      join(
        process.cwd(),
        "components/onboarding/setup/capability-setup-tile.tsx",
      ),
      "utf8",
    );

    // "Required" in the same muted grey as every other trailing label reads as
    // one more optional status. The blocking row takes the accent pill and the
    // current-step role so it is legible as the thing to do first.
    expect(hub).toContain('statusLabel={runtimeChoiceComplete ? "Selected" : "Required"}');
    expect(hub).toContain('statusTone={runtimeChoiceComplete ? "muted" : "required"}');
    expect(tile).toContain('statusTone === "required"');
    expect(tile).toContain("bg-[var(--app-accent-tint)]");
    expect(tile).toContain('aria-current={isCurrent ? "step" : undefined}');
  });

  it("uses the canonical setup icon geometry instead of a setup-specific icon map", () => {
    const tile = readFileSync(
      join(
        process.cwd(),
        "components/onboarding/setup/capability-setup-tile.tsx",
      ),
      "utf8",
    );
    const icon = readFileSync(
      join(process.cwd(), "components/app-ui/agent-section-icon.tsx"),
      "utf8",
    );

    expect(tile).toContain("AgentSectionIcon");
    expect(tile).toContain('size="setup"');
    expect(icon).toContain("setup: {");
    expect(icon).toContain('glyphSurface: "h-9 w-9 rounded-[10px]"');
    expect(icon).toContain('glyph: "h-[22px] w-[22px]"');
  });


  it("does not publish the master action before the AI-access choice settles", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    expect(source).toContain(
      'const hubStateLoading = runtimeChoiceState === "loading"',
    );
    expect(source).toContain("<SetupHubLoadingState />");
    expect(source).not.toContain("<Skeleton");
    expect(source).toContain("Checking your setup…");
    expect(source).toContain(
      "hubStateLoading || dismissing || !runtimeChoiceComplete",
    );
  });


  it("keeps the mandatory-step language out of system nouns", () => {
    const hub = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    // "vault" is an implementation noun. It stays in the code (services,
    // props, test ids) and out of anything a person reads. Every phrase below
    // was rendered on this hub or spoken back by the setup guide.
    const retiredCopy = [
      "Your vault is required to finish setup.",
      "Your vault is required. You can add more capabilities any time.",
      "Your private vault gives One end-to-end encryption.",
      "Your private vault is not ready yet.",
      "Set up private vault",
      "Set up your private vault",
      "Continue to set up your private vault.",
      "Choose an AI access option before continuing.",
      "We could not protect your setup.",
    ];
    for (const phrase of retiredCopy) {
      expect(hub).not.toContain(phrase);
    }

    expect(hub).toContain("Only you can open what you save.");
    expect(hub).toContain("Not even we can read it.");
    // "Add" was the wrong verb for a list of things you SET UP, and the line
    // is the last thing read before "Finish setup".
    expect(hub).not.toContain('"Set up the rest later."');
    expect(hub).not.toContain('"Add the rest any time."');
  });

  it("keeps the quiet Morphy action legible on hover and while disabled", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "components/onboarding/setup/setup-completion-footer.tsx",
      ),
      "utf8",
    );

    expect(source).toContain('size="prominent"');
    expect(source).toContain("disabled={disabled || blocked}");
    expect(source).not.toContain("disabled:!opacity-100");
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


  it("does not reserve header space for a duplicate mobile action", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    expect(source).not.toContain('<div className="flex flex-wrap items-start gap-3">');
    expect(source).not.toContain('<div className="min-w-[8rem] flex-1">');
    expect(source).not.toContain('<div className="min-w-0 flex-1">');
    expect(source).not.toContain("basis-[8rem]");
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
    expect(source).toContain("Set a lock");
    expect(source).not.toContain("I’ll do this later");
    expect(source).not.toContain("one-setup-vault-invitation-later");
    expect(source).toContain("<VaultUnlockDialog");
    expect(source).toContain("dismissible={false}");
    expect(source).toContain("PreVaultSensitiveDraftService.finalizeForVault");
    expect(source).toContain("PostUnlockSyncService.run");
    expect(source).toContain("onSuccess={() => undefined}");
  });

  it("opens the last step straight from Finish setup, with no screen in between", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    // The hub used to replace its whole body with an invitation screen whose
    // only control opened this dialog -- a full screen and an extra tap in
    // front of the last step. Finish setup now opens the lock step itself.
    const masterAckStart = source.indexOf("const handleMasterAck");
    const masterHandler = source.slice(
      masterAckStart,
      source.indexOf("useLocalOnboardingActionHandler", masterAckStart),
    );
    expect(masterHandler).toContain("setVaultDialogOpen(true);");
    expect(source).not.toContain("showVaultInvitation");
    expect(source).not.toContain('data-testid="one-setup-vault-invitation"');
    expect(source).not.toContain("A private place for what matters");
    expect(source).not.toContain('data-testid="one-setup-vault-invitation-open"');

    // ...and the promise that screen carried moves onto the step that needs it.
    const vaultFlow = readFileSync(
      join(process.cwd(), "components/vault/vault-flow.tsx"),
      "utf8",
    );
    expect(vaultFlow).toContain('description="Only you can open what you save."');
  });

  it("keeps AI access one tap from the hub instead of behind a prologue", () => {
    const page = readFileSync(
      join(
        process.cwd(),
        "components/connections/gemini-runtime-configuration-page.tsx",
      ),
      "utf8",
    );
    const gate = readFileSync(
      join(
        process.cwd(),
        "components/onboarding/setup/capability-cinematic-intro.tsx",
      ),
      "utf8",
    );

    // AI access is the one step that blocks finishing setup. A prologue with
    // its own Continue button in front of a two-option choice is pure friction.
    expect(page).not.toContain("CapabilityCinematicIntroGate");
    expect(gate).not.toContain('"connections"');
    // The provider marks the prologue used to carry now render inline on the
    // real screen, so no context is lost with the screen.
    expect(page).toContain("data-runtime-provider-lane");
    expect(page).toContain("RUNTIME_PROVIDER_CATALOG");
    expect(gate).not.toContain("data-runtime-provider-lane");

    // Saving either choice requires a separate, enabled Continue action.
    expect(page).not.toContain("void finishSetupAndGoHome();");
    expect(page).toContain("disabled={!canContinue || finishing}");
  });

  it("names the recommended AI option so the default is not worked out by elimination", () => {
    const card = readFileSync(
      join(
        process.cwd(),
        "components/connections/gemini-runtime-settings-card.tsx",
      ),
      "utf8",
    );

    expect(card).toContain('<Badge variant="outline">Recommended</Badge>');
    expect(card).toContain('title="Use Hussh\'s AI"');
    expect(card).toContain('title="Use my own key"');
    // System nouns and vendor plumbing stay out of the two rows a person reads.
    expect(card).not.toContain("Hussh managed Gemini");
    expect(card).not.toContain("Use my Gemini access");
    expect(card).not.toContain(
      "It stays only in this session until your private vault is ready.",
    );
  });

  it("requires a vault before saving KYC identity information", () => {
    const kycPrefaceSource = readFileSync(
      join(process.cwd(), "components/onboarding/setup/kyc-identity-preface.tsx"),
      "utf8",
    );
    expect(kycPrefaceSource).toContain("VaultUnlockDialog");

    const vaultFreeSetupSurfaces = [
      "app/one/setup/location/location-onboarding-setup-client.tsx",
    ];

    for (const relativePath of vaultFreeSetupSurfaces) {
      const source = readFileSync(join(process.cwd(), relativePath), "utf8");
      expect(source).not.toContain("VaultUnlockDialog");
      expect(source).not.toContain("CapabilityVaultPrerequisite");
    }

    const emailSetupSource = readFileSync(
      join(process.cwd(), "app/one/setup/email/email-onboarding-setup-client.tsx"),
      "utf8",
    );
    const kycRouteSource = readFileSync(
      join(process.cwd(), "app/one/kyc/page.tsx"),
      "utf8",
    );
    expect(emailSetupSource).toContain("CapabilityVaultPrerequisite");
    expect(kycRouteSource).toContain("<KycIdentityPreface");
    const vaultGuard = kycPrefaceSource.indexOf("if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken)");
    const save = kycPrefaceSource.indexOf("KycIdentityProfilePkmService.saveProfile");
    expect(vaultGuard).toBeGreaterThanOrEqual(0);
    expect(save).toBeGreaterThan(vaultGuard);
    expect(kycPrefaceSource.slice(vaultGuard, save)).toContain("setVaultDialogOpen(true)");
    expect(kycPrefaceSource.slice(vaultGuard, save)).toContain("return;");

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
