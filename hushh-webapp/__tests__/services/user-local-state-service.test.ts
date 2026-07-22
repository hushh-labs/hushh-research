import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearPreVault: vi.fn(),
  clearKaiNavTour: vi.fn(),
  clearRiaOnboardingDraft: vi.fn(),
  clearVaultMethodPrompt: vi.fn(),
}));

vi.mock("@/lib/services/pre-vault-onboarding-service", () => ({
  PreVaultOnboardingService: { clear: mocks.clearPreVault },
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
}));

import { UserLocalStateService } from "@/lib/services/user-local-state-service";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";

describe("UserLocalStateService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.clearPreVault.mockResolvedValue(undefined);
    mocks.clearKaiNavTour.mockResolvedValue(undefined);
    mocks.clearRiaOnboardingDraft.mockResolvedValue(undefined);
    mocks.clearVaultMethodPrompt.mockResolvedValue(undefined);
  });

  it("clears all user-scoped local state, including RIA onboarding drafts", async () => {
    await UserLocalStateService.clearForUser("uid-1");

    expect(mocks.clearPreVault).toHaveBeenCalledWith("uid-1");
    expect(mocks.clearKaiNavTour).toHaveBeenCalledWith("uid-1");
    expect(mocks.clearRiaOnboardingDraft).toHaveBeenCalledWith("uid-1");
    expect(mocks.clearVaultMethodPrompt).toHaveBeenCalledWith("uid-1");
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
