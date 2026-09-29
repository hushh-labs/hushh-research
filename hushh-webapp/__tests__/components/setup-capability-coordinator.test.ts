import { describe, expect, it } from "vitest";

import {
  hasUnresolvedRootSetup,
  resolveSetupCapabilityJourneyMode,
  resolveSetupCapabilityReturnTarget,
  resolveSetupCapabilityTerminalScreen,
  resolveSetupCapabilityTerminalTarget,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { buildOneSetupFinanceImportRoute, ROUTES } from "@/lib/navigation/routes";
import type { PreVaultUserState } from "@/lib/services/pre-vault-user-state-service";

describe("setup capability journey settlement", () => {
  it("derives root versus individual re-entry only from fresh setup resolution", () => {
    expect(resolveSetupCapabilityJourneyMode("auto", false)).toBe("root");
    expect(resolveSetupCapabilityJourneyMode("auto", true)).toBe("individual");
    expect(resolveSetupCapabilityJourneyMode("root", true)).toBe("root");
    expect(resolveSetupCapabilityJourneyMode("individual", false)).toBe(
      "individual",
    );
  });

  it("does not mistake a legacy Nav-tour outcome for root setup completion", () => {
    expect(
      hasUnresolvedRootSetup({
        setupCompleted: false,
        navSetupCompletedAt: Date.parse("2026-07-01T00:00:00.000Z"),
        navSetupSkippedAt: null,
      } as PreVaultUserState),
    ).toBe(true);
    expect(
      hasUnresolvedRootSetup({
        setupCompleted: true,
        navSetupCompletedAt: null,
        navSetupSkippedAt: null,
      } as PreVaultUserState),
    ).toBe(false);
  });

  it("returns root setup to the hub and individual setup directly to One", () => {
    expect(
      resolveSetupCapabilityReturnTarget({
        capabilityId: "finance",
        journeyMode: "root",
        hasExplicitIncompleteSetup: true,
      }),
    ).toBe("/one/setup");
    expect(
      resolveSetupCapabilityReturnTarget({
        capabilityId: "finance",
        journeyMode: "individual",
        hasExplicitIncompleteSetup: false,
      }),
    ).toBe("/one");
  });

  it("keeps a finished Location setup on the hub while overall setup is still incomplete", () => {
    // The master "Finish setup" (which requires Connections) is not done yet,
    // so finishing Location must return the user to /one/setup — not jump
    // straight into the Location workspace.
    expect(
      resolveSetupCapabilityTerminalTarget({
        capabilityId: "location",
        journeyMode: "root",
        hasExplicitIncompleteSetup: true,
        kind: "finish",
      }),
    ).toBe("/one/setup");
    expect(
      resolveSetupCapabilityTerminalTarget({
        capabilityId: "location",
        journeyMode: "root",
        hasExplicitIncompleteSetup: true,
        kind: "skip",
      }),
    ).toBe("/one/setup");
  });

  it("lands a finished Location setup on its workspace once overall setup is resolved", () => {
    // Overall setup is complete (Finish setup done), so finishing Location may
    // hand off directly to the Location workspace.
    expect(
      resolveSetupCapabilityTerminalTarget({
        capabilityId: "location",
        journeyMode: "root",
        hasExplicitIncompleteSetup: false,
        kind: "finish",
      }),
    ).toBe("/one/location");
    // Skip never widens into the workspace shortcut.
    expect(
      resolveSetupCapabilityTerminalTarget({
        capabilityId: "location",
        journeyMode: "root",
        hasExplicitIncompleteSetup: false,
        kind: "skip",
      }),
    ).toBe("/one/location");
    expect(
      resolveSetupCapabilityTerminalTarget({
        capabilityId: "location",
        journeyMode: "individual",
        hasExplicitIncompleteSetup: false,
        kind: "finish",
      }),
    ).toBe("/one");
    expect(resolveSetupCapabilityTerminalScreen("/one/location")).toBe(
      "one_location",
    );
    expect(resolveSetupCapabilityTerminalScreen("/one/setup")).toBe(
      "one_setup_hub",
    );
  });

  it("lands a Finance re-entry terminal (including \"I'll link this later\") on Finance, not One", () => {
    // Root setup is resolved, so Finance setup is an individual re-entry from
    // the Finance workspace. The import step's "I'll link this later" footer
    // settles through `finish`; neither terminal may drop the person on /one.
    for (const kind of ["finish", "skip"] as const) {
      const target = resolveSetupCapabilityTerminalTarget({
        capabilityId: "finance",
        journeyMode: "individual",
        hasExplicitIncompleteSetup: false,
        kind,
      });
      expect(target).toBe(ROUTES.KAI_HOME);
      expect(target).not.toBe(ROUTES.ONE_HOME);
    }
    expect(resolveSetupCapabilityTerminalScreen(ROUTES.KAI_HOME)).toBeDefined();
  });

  it("keeps a first-run Finance terminal on the setup hub", () => {
    // The master "Finish setup" is still outstanding, so the Finance workspace
    // is not reachable yet; the hub remains the only safe destination.
    for (const kind of ["finish", "skip"] as const) {
      expect(
        resolveSetupCapabilityTerminalTarget({
          capabilityId: "finance",
          journeyMode: "root",
          hasExplicitIncompleteSetup: true,
          kind,
        }),
      ).toBe(ROUTES.ONE_SETUP);
    }
  });

  it("retains a validated invitation only after root setup, including an explicit skip", () => {
    const invite = "/circle/join?invite=opaque_token";
    expect(buildOneSetupFinanceImportRoute(invite)).toBe(
      ROUTES.ONE_SETUP_FINANCE_IMPORT + "?return_to=" + encodeURIComponent(invite),
    );
    for (const kind of ["finish", "skip"] as const) {
      expect(resolveSetupCapabilityTerminalTarget({
        capabilityId: "finance", journeyMode: "individual",
        hasExplicitIncompleteSetup: false, kind, returnTo: invite,
      })).toBe(invite);
      expect(resolveSetupCapabilityTerminalTarget({
        capabilityId: "finance", journeyMode: "root",
        hasExplicitIncompleteSetup: true, kind, returnTo: invite,
      })).toBe(ROUTES.ONE_SETUP);
    }
    for (const unsafe of ["https://outside.example/", "//outside.example/", "javascript:alert(1)", ROUTES.ONE_SETUP]) {
      expect(buildOneSetupFinanceImportRoute(unsafe)).toBe(ROUTES.ONE_SETUP_FINANCE_IMPORT);
      expect(resolveSetupCapabilityTerminalTarget({
        capabilityId: "finance", journeyMode: "individual",
        hasExplicitIncompleteSetup: false, kind: "finish", returnTo: unsafe,
      })).toBe(ROUTES.KAI_HOME);
    }
  });

  it("still returns other individual capability terminals to One", () => {
    expect(
      resolveSetupCapabilityTerminalTarget({
        capabilityId: "gmail",
        journeyMode: "individual",
        hasExplicitIncompleteSetup: false,
        kind: "finish",
      }),
    ).toBe(ROUTES.ONE_HOME);
  });
});
