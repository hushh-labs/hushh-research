import { beforeEach, describe, expect, it, vi } from "vitest";

const hasRunningTaskMock = vi.fn();
const onboardingLoadMock = vi.fn();
const finalizeKnownVaultCommitMock = vi.fn();
const completeAfterVaultCommitMock = vi.fn();
const markCompletedMock = vi.fn();
const navLoadMock = vi.fn();
const navMarkSyncedMock = vi.fn();
const syncOnboardingAndNavStateMock = vi.fn();

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    hasRunningTask: (...args: unknown[]) => hasRunningTaskMock(...args),
  },
}));

vi.mock("@/lib/services/pre-vault-onboarding-service", () => ({
  PreVaultOnboardingService: {
    load: (...args: unknown[]) => onboardingLoadMock(...args),
    finalizeKnownVaultCommit: (...args: unknown[]) =>
      finalizeKnownVaultCommitMock(...args),
    completeAfterVaultCommit: (...args: unknown[]) =>
      completeAfterVaultCommitMock(...args),
    markCompleted: (...args: unknown[]) => markCompletedMock(...args),
  },
}));

vi.mock("@/lib/services/kai-nav-tour-local-service", () => ({
  KaiNavTourLocalService: {
    load: (...args: unknown[]) => navLoadMock(...args),
    markSynced: (...args: unknown[]) => navMarkSyncedMock(...args),
  },
}));

vi.mock("@/lib/services/kai-profile-service", () => ({
  KaiProfileService: {
    syncOnboardingAndNavState: (...args: unknown[]) =>
      syncOnboardingAndNavStateMock(...args),
  },
  computeRiskScore: vi.fn(() => 3),
  mapRiskProfile: vi.fn(() => "balanced"),
}));

import { KaiProfileSyncService } from "@/lib/services/kai-profile-sync-service";

const USER_ID = "uid-sync";
const VAULT_KEY = "ab".repeat(32);

const onboarding = {
  version: 1 as const,
  completed: true,
  skipped: false,
  completed_at: "2026-07-30T00:00:00.000Z",
  answers: {
    investment_horizon: "long_term" as const,
    drawdown_response: "stay" as const,
    volatility_preference: "moderate" as const,
  },
  risk_score: 3,
  risk_profile: "balanced" as const,
  synced_to_vault_at: null,
  updated_at: "2026-07-30T00:00:00.000Z",
};

describe("KaiProfileSyncService pre-vault migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasRunningTaskMock.mockReturnValue(false);
    finalizeKnownVaultCommitMock.mockResolvedValue(false);
    onboardingLoadMock.mockResolvedValue(onboarding);
    navLoadMock.mockResolvedValue(null);
    syncOnboardingAndNavStateMock.mockResolvedValue({});
    markCompletedMock.mockResolvedValue(onboarding);
    completeAfterVaultCommitMock.mockResolvedValue(true);
    navMarkSyncedMock.mockResolvedValue(null);
  });

  it("retries cleanup only when an encrypted PKM commit was already recorded", async () => {
    finalizeKnownVaultCommitMock.mockResolvedValueOnce(true);

    await expect(
      KaiProfileSyncService.syncPendingToVault({
        userId: USER_ID,
        vaultKey: VAULT_KEY,
      }),
    ).resolves.toEqual({ synced: true, reason: "pre_vault_source_retired" });

    expect(syncOnboardingAndNavStateMock).not.toHaveBeenCalled();
    expect(completeAfterVaultCommitMock).not.toHaveBeenCalled();
  });

  it("retires the local pre-vault origin only after the encrypted PKM write", async () => {
    await KaiProfileSyncService.syncPendingToVault({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
      vaultOwnerToken: "owner-token",
    });

    expect(syncOnboardingAndNavStateMock).toHaveBeenCalledOnce();
    expect(completeAfterVaultCommitMock).toHaveBeenCalledWith({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
    });
    expect(
      syncOnboardingAndNavStateMock.mock.invocationCallOrder[0],
    ).toBeLessThan(completeAfterVaultCommitMock.mock.invocationCallOrder[0]);
  });
});
