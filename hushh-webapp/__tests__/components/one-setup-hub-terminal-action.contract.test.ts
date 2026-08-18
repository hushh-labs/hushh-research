import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("One setup hub terminal action contract", () => {
  it("routes completed rows through their canonical setup entry", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    expect(source.match(/href=\{item\.copy\.href\}/g)).toHaveLength(1);
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

    expect(source).toContain('const masterActionLabel = "Continue"');
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

  it("keeps AI access as its own highlighted step instead of a separate private configuration section", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    expect(source).toContain('title="Start here"');
    expect(source).toContain('title="Add anytime"');
    expect(source).toContain('title="Choose AI"');
    expect(source).toContain("<SetupNavigationTile");
    expect(source).toContain('voiceControlId="one_setup_tile_connections"');
    expect(source).not.toContain("Private configuration");
    expect(source.indexOf('title="Choose AI"')).toBeLessThan(
      source.indexOf("<CapabilitySetupTile"),
    );
  });

  it("marks the one mandatory row with a blue accent action instead of a quiet grey status", () => {
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

    // No "Required" badge: the row itself is the one soft-blue highlighted
    // surface on the screen, with a blue "Start" action and the current-step
    // role, so it reads as the thing to do first without a status pill.
    expect(hub).toContain('statusLabel={runtimeChoiceComplete ? undefined : "Start"}');
    expect(hub).toContain("isCurrent={!runtimeChoiceComplete}");
    expect(hub).toContain("bg-[var(--app-accent-tint)]");
    expect(hub).not.toContain("Required");
    expect(tile).toContain("text-[var(--app-accent)]");
    expect(tile).toContain('aria-current={isCurrent ? "step" : undefined}');
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
    expect(source).toContain("Checking your setup…");
    expect(source).toMatch(/actions:\s*hubStateLoading\s*\?\s*\[\]\s*:/);
    expect(stateHook).toContain("useState(enrichVault)");
    expect(stateHook).toContain("useState(enrichOauth)");
    expect(stateHook).toContain("useState(enrichRia)");
  });

  it("spends the accent only on a finish that can actually go through", () => {
    const hub = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );
    const footer = readFileSync(
      join(
        process.cwd(),
        "components/onboarding/setup/setup-completion-footer.tsx",
      ),
      "utf8",
    );

    // Both master actions are gated on the same mandatory AI access choice,
    // and both must LOOK gated. `disabled:opacity-40/50` over the accent still
    // reads as the blue primary action, which is what made a blocked finish
    // look tappable and then swallow the tap.
    expect(footer).toContain(
      "const isBlockedFilledAction = disabled && !busy && !isQuietSetupAction",
    );
    expect(footer).toContain("disabled:!bg-muted/60");
    // ...and a visible edge with it. `muted` is the page surface in the light
    // theme, so the fill alone leaves no control on screen.
    expect(footer).toContain("disabled:!border-border");

    // The reason travels with the block: the blocked-handler summary and the
    // one full-width footer's supporting line both name it, so there is
    // exactly one place on screen (plus the handler's own return summary)
    // explaining why Continue will not go through yet.
    expect(hub).toContain('"Choose your AI first."');
    expect(
      hub.match(/Choose your AI first\./g)?.length,
    ).toBe(2);
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
    expect(hub).toContain('"Set up the rest later."');
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

  it("surfaces one full-width Continue action for every breakpoint instead of a second top-right control", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    // Continue moved into the one full-width footer below the list. There is
    // no separate top-right mobile action competing with it or with the title.
    expect(source).not.toContain('data-testid="one-setup-master-ack-mobile"');
    expect(source).not.toContain('<div className="hidden sm:block">');
    expect(source).toContain("<SetupCompletionFooter");
    expect(source).toContain('testId="one-setup-master-ack"');
    expect(source).toContain("label={masterActionLabel}");
  });

  it("keeps the header a plain title and subtitle now that nothing competes with it", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/setup/one-setup-hub.tsx"),
      "utf8",
    );

    // The header used to share a flex row with a top-right Skip/Finish button
    // that could run through the title at small widths / large text settings.
    // That button is gone, so the header needs no wrapping workaround for it.
    expect(source).not.toContain('data-testid="one-setup-master-ack-mobile"');
    expect(source).toContain("<AppPageHeaderRegion>");
    expect(source).toContain("<PageHeader");
    expect(source.indexOf("<AppPageHeaderRegion>")).toBeLessThan(
      source.indexOf("</AppPageHeaderRegion>"),
    );
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

    // Taking the recommended option is the entire decision, so it finishes the
    // step. Bring-your-own-key still continues through the footer, because it
    // has a form left to fill.
    expect(page).toContain('if (choice === "hushh_managed_vertex") {');
    expect(page).toContain("returnToSetupHub();");
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
