import { beforeEach, describe, expect, it, vi } from "vitest";

const loadMock = vi.fn();
const markSyncedMock = vi.fn();
const setNavTourStateMock = vi.fn();

vi.mock("@/lib/services/kai-nav-tour-local-service", () => ({
  KaiNavTourLocalService: {
    load: (...args: unknown[]) => loadMock(...args),
    markSynced: (...args: unknown[]) => markSyncedMock(...args),
  },
}));

vi.mock("@/lib/services/kai-profile-service", () => ({
  KaiProfileService: {
    setNavTourState: (...args: unknown[]) =>
      setNavTourStateMock(...args),
  },
}));

import { KaiNavTourSyncService } from "@/lib/services/kai-nav-tour-sync-service";

describe("KaiNavTourSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns no_pending_state when no local state exists", async () => {
    loadMock.mockResolvedValue(null);

    const result = await KaiNavTourSyncService.syncPendingToVault({
      userId: "user-1",
      vaultKey: "vault-key",
    });

    expect(result).toEqual({
      synced: false,
      reason: "no_pending_state",
    });
  });

  it("returns already_synced when state was already synced", async () => {
    loadMock.mockResolvedValue({
      synced_to_vault_at: "2026-01-01T00:00:00.000Z",
    });

    const result = await KaiNavTourSyncService.syncPendingToVault({
      userId: "user-1",
      vaultKey: "vault-key",
    });

    expect(result).toEqual({
      synced: false,
      reason: "already_synced",
    });
  });

  it("returns not_completed when tour was neither completed nor skipped", async () => {
    loadMock.mockResolvedValue({
      synced_to_vault_at: null,
      completed_at: null,
      skipped_at: null,
    });

    const result = await KaiNavTourSyncService.syncPendingToVault({
      userId: "user-1",
      vaultKey: "vault-key",
    });

    expect(result).toEqual({
      synced: false,
      reason: "not_completed",
    });
  });

  it("syncs completed state to vault", async () => {
    loadMock.mockResolvedValue({
      completed_at: "2026-01-01T00:00:00.000Z",
      skipped_at: null,
      synced_to_vault_at: null,
    });

    setNavTourStateMock.mockResolvedValue({});
    markSyncedMock.mockResolvedValue({});

    const result = await KaiNavTourSyncService.syncPendingToVault({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    });

    expect(setNavTourStateMock).toHaveBeenCalledWith({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      completedAt: "2026-01-01T00:00:00.000Z",
      skippedAt: null,
    });

    expect(markSyncedMock).toHaveBeenCalledWith("user-1");

    expect(result).toEqual({
      synced: true,
    });
  });
});
