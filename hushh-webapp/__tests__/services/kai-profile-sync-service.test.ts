import { beforeEach, describe, expect, it, vi } from "vitest";

const hasRunningTaskMock = vi.fn();
const syncOnboardingAndNavStateMock = vi.fn();
const markSyncedMock = vi.fn();
const markNavSyncedMock = vi.fn();
const getVaultStateMock = vi.fn();
const assertVaultKeyMatchesStateMock = vi.fn();

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    hasRunningTask: (...args: unknown[]) => hasRunningTaskMock(...args),
  },
}));

vi.mock("@/lib/services/kai-profile-service", () => ({
  computeRiskScore: vi.fn(() => 3),
  mapRiskProfile: vi.fn(() => "balanced"),
  KaiProfileService: {
    syncOnboardingAndNavState: (...args: unknown[]) => syncOnboardingAndNavStateMock(...args),
  },
}));

vi.mock("@/lib/services/kai-nav-tour-local-service", () => ({
  KaiNavTourLocalService: {
    load: vi.fn(async () => null),
    markSynced: (...args: unknown[]) => markNavSyncedMock(...args),
  },
}));

vi.mock("@/lib/services/pre-vault-onboarding-service", () => ({
  PreVaultOnboardingService: {
    load: vi.fn(async () => null),
    markCompleted: vi.fn(async () => undefined),
    markSynced: (...args: unknown[]) => markSyncedMock(...args),
  },
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    getVaultState: (...args: unknown[]) => getVaultStateMock(...args),
    assertVaultKeyMatchesState: (...args: unknown[]) => assertVaultKeyMatchesStateMock(...args),
  },
}));

import { KaiProfileSyncService } from "@/lib/services/kai-profile-sync-service";

describe("KaiProfileSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasRunningTaskMock.mockReturnValue(false);
    getVaultStateMock.mockResolvedValue({ vaultKeyHash: "hash" });
    assertVaultKeyMatchesStateMock.mockResolvedValue(undefined);
    syncOnboardingAndNavStateMock.mockResolvedValue({});
    markSyncedMock.mockResolvedValue(undefined);
    markNavSyncedMock.mockResolvedValue(undefined);
  });

  it("validates the vault key before syncing pending state into PKM", async () => {
    await expect(
      KaiProfileSyncService.syncPendingToVault({
        userId: "user-1",
        vaultKey: "vault-key",
        vaultOwnerToken: "vault-owner-token",
        pendingState: {
          hasPending: true,
          onboardingPayload: {
            completed: true,
            skippedPreferences: true,
          },
        },
      })
    ).resolves.toEqual({ synced: true });

    expect(getVaultStateMock).toHaveBeenCalledWith("user-1");
    expect(assertVaultKeyMatchesStateMock).toHaveBeenCalledWith(
      { vaultKeyHash: "hash" },
      "vault-key"
    );
    expect(syncOnboardingAndNavStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        vaultKey: "vault-key",
        vaultOwnerToken: "vault-owner-token",
        onboarding: {
          completed: true,
          skippedPreferences: true,
        },
      })
    );
    expect(markSyncedMock).toHaveBeenCalledWith("user-1");
    expect(markNavSyncedMock).not.toHaveBeenCalled();
  });

  it("aborts the sync pipeline when vault validation fails", async () => {
    const validationError = new Error("Vault key integrity check failed.");
    assertVaultKeyMatchesStateMock.mockRejectedValue(validationError);

    await expect(
      KaiProfileSyncService.syncPendingToVault({
        userId: "user-1",
        vaultKey: "wrong-vault-key",
        vaultOwnerToken: "vault-owner-token",
        pendingState: {
          hasPending: true,
          onboardingPayload: {
            completed: true,
            skippedPreferences: true,
          },
        },
      })
    ).rejects.toThrow("Vault key integrity check failed.");

    expect(getVaultStateMock).toHaveBeenCalledWith("user-1");
    expect(assertVaultKeyMatchesStateMock).toHaveBeenCalledWith(
      { vaultKeyHash: "hash" },
      "wrong-vault-key"
    );
    expect(syncOnboardingAndNavStateMock).not.toHaveBeenCalled();
    expect(markSyncedMock).not.toHaveBeenCalled();
    expect(markNavSyncedMock).not.toHaveBeenCalled();
  });
});
