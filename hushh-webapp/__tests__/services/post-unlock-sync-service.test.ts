import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/kai-profile-sync-service", () => ({
  KaiProfileSyncService: {
    syncPendingToVault: vi.fn(),
  },
}));

import { KaiProfileSyncService } from "@/lib/services/kai-profile-sync-service";
import { PostUnlockSyncService } from "@/lib/services/post-unlock-sync-service";

const syncPendingToVault = vi.mocked(
  KaiProfileSyncService.syncPendingToVault
);

describe("PostUnlockSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns onboardingSynced true when sync succeeds", async () => {
    syncPendingToVault.mockResolvedValue({
      synced: true,
    });

    const result = await PostUnlockSyncService.run({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    });

    expect(syncPendingToVault).toHaveBeenCalledWith({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    });

    expect(result).toEqual({
      onboardingSynced: true,
    });
  });

  it("returns onboardingSynced false when sync reports failure", async () => {
    syncPendingToVault.mockResolvedValue({
      synced: false,
    });

    const result = await PostUnlockSyncService.run({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    });

    expect(result).toEqual({
      onboardingSynced: false,
    });
  });

  it("returns onboardingSynced false when sync throws", async () => {
    syncPendingToVault.mockRejectedValue(
      new Error("sync failed")
    );

    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    const result = await PostUnlockSyncService.run({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    });

    expect(result).toEqual({
      onboardingSynced: false,
    });

    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
