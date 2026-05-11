import { beforeEach, describe, expect, it, vi } from "vitest";

const syncPendingToVaultMock = vi.fn();

vi.mock("@/lib/services/kai-profile-sync-service", () => ({
  KaiProfileSyncService: {
    syncPendingToVault: (...args: unknown[]) => syncPendingToVaultMock(...args),
  },
}));

import { PostUnlockSyncService } from "@/lib/services/post-unlock-sync-service";

describe("PostUnlockSyncService encrypted PKM bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("boots pending onboarding into encrypted PKM with vault key and owner token", async () => {
    syncPendingToVaultMock.mockResolvedValueOnce({ synced: true });

    const result = await PostUnlockSyncService.run({
      userId: "user-1",
      vaultKey: "vault-key-material",
      vaultOwnerToken: "vault-owner-token",
    });

    expect(result).toEqual({ onboardingSynced: true });
    expect(syncPendingToVaultMock).toHaveBeenCalledWith({
      userId: "user-1",
      vaultKey: "vault-key-material",
      vaultOwnerToken: "vault-owner-token",
    });
  });

  it("keeps encrypted PKM bootstrap failures non-fatal", async () => {
    syncPendingToVaultMock.mockRejectedValueOnce(new Error("PKM_WRITE_FAILED"));

    const result = await PostUnlockSyncService.run({
      userId: "user-1",
      vaultKey: "vault-key-material",
      vaultOwnerToken: "vault-owner-token",
    });

    expect(result).toEqual({ onboardingSynced: false });
  });
});
