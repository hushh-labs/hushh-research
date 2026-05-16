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

import { UserLocalStateService } from "@/lib/services/user-local-state-service";

describe("UserLocalStateService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
