import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearPreVault: vi.fn(),
  clearPreVaultSensitive: vi.fn(),
  clearFinanceSetupDraft: vi.fn(),
  clearKaiNavTour: vi.fn(),
  clearRiaOnboardingDraft: vi.fn(),
  clearVaultMethodPrompt: vi.fn(),
  forgetLocationMemory: vi.fn(),
}));

// Mocked rather than exercised for real: location-grant-memory reaches
// encryption -> HushhKeychain, and this file mocks only @capacitor/core.
// location-grant-memory.test.ts owns the durable behaviour; this file owns the
// wiring. Both are needed — either alone passes while the other half is broken.
vi.mock("@/lib/one-location/location-grant-memory", () => ({
  forgetLocationMemory: mocks.forgetLocationMemory,
}));

vi.mock("@/lib/services/pre-vault-onboarding-service", () => ({
  PreVaultOnboardingService: { clear: mocks.clearPreVault },
}));

vi.mock("@/lib/services/pre-vault-sensitive-draft-service", () => ({
  PreVaultSensitiveDraftService: { clearForUser: mocks.clearPreVaultSensitive },
}));

vi.mock("@/lib/services/finance-setup-draft-service", () => ({
  FinanceSetupDraftService: { clear: mocks.clearFinanceSetupDraft },
}));

vi.mock("@/lib/services/kai-nav-tour-local-service", () => ({
  KaiNavTourLocalService: { clear: mocks.clearKaiNavTour },
}));

vi.mock("@/lib/services/ria-onboarding-draft-local-service", () => ({
  RiaOnboardingDraftLocalService: { clear: mocks.clearRiaOnboardingDraft },
}));

vi.mock("@/lib/services/vault-method-prompt-local-service", () => ({
  VaultMethodPromptLocalService: { clear: mocks.clearVaultMethodPrompt },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: vi.fn(() => ({})),
}));

import { UserLocalStateService } from "@/lib/services/user-local-state-service";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";

describe("UserLocalStateService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.clearPreVault.mockResolvedValue(undefined);
    mocks.clearPreVaultSensitive.mockReturnValue(undefined);
    mocks.clearFinanceSetupDraft.mockResolvedValue(undefined);
    mocks.clearKaiNavTour.mockResolvedValue(undefined);
    mocks.clearRiaOnboardingDraft.mockResolvedValue(undefined);
    mocks.clearVaultMethodPrompt.mockResolvedValue(undefined);
  });

  it("clears all user-scoped local state, including RIA onboarding drafts", async () => {
    await UserLocalStateService.clearForUser("uid-1");

    expect(mocks.clearPreVault).toHaveBeenCalledWith("uid-1");
    expect(mocks.clearPreVaultSensitive).toHaveBeenCalledWith("uid-1");
    expect(mocks.clearFinanceSetupDraft).toHaveBeenCalledWith("uid-1");
    expect(mocks.clearKaiNavTour).toHaveBeenCalledWith("uid-1");
    expect(mocks.clearRiaOnboardingDraft).toHaveBeenCalledWith("uid-1");
    expect(mocks.clearVaultMethodPrompt).toHaveBeenCalledWith("uid-1");
  });

  it("forgets the remembered location grant and the sealed last-known fix", async () => {
    // These two records are the only user-scoped local state that describes
    // where a person physically was: a sealed coordinate kept for 24h and a
    // grant kept for 90d. Both were shipped with no caller for the function
    // that deletes them, so they outlived sign-out on a shared device.
    await UserLocalStateService.clearForUser("uid-1");

    expect(mocks.forgetLocationMemory).toHaveBeenCalledWith("uid-1");
  });

  it("still forgets location even when another cleanup rejects", async () => {
    // The settled batch swallows rejections, but only for work queued after
    // this point. Location teardown runs synchronously and ahead of it for
    // exactly this reason: an unrelated failure must not be able to leave a
    // coordinate behind.
    mocks.clearRiaOnboardingDraft.mockRejectedValue(new Error("storage full"));

    await UserLocalStateService.clearForUser("uid-1");

    expect(mocks.forgetLocationMemory).toHaveBeenCalledWith("uid-1");
  });

  it("clears the setup completion latch so onboarding can re-arm", async () => {
    // The completion latch is a sticky "onboarding dismissed" signal that is
    // NEVER cleared by a routine backend read — only by an explicit sign-out /
    // account reset through here. If this regresses, a reset user is wrongly
    // admitted and can never re-run onboarding on this device.
    OneSetupCompletionHintService.markResolved("uid-rearm");
    expect(OneSetupCompletionHintService.isResolved("uid-rearm")).toBe(true);

    await UserLocalStateService.clearForUser("uid-rearm");

    expect(OneSetupCompletionHintService.isResolved("uid-rearm")).toBe(false);
  });
});
