// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    revokeGrant: vi.fn(),
    revokePublicInvite: vi.fn(),
    stopBackgroundShare: vi.fn(),
  },
}));

import { OneLocationService } from "@/lib/one-location/service";
import {
  pendingLocationRevocationGrantIds,
  pendingLocationRevocationStorageKey,
  pendingPublicInviteRevocationIds,
  retryPendingPublicInviteRevocations,
  retryPendingLocationRevocations,
  revokePublicInviteOrQueue,
  revokeLocationGrantOrQueue,
} from "@/lib/one-location/location-revocation-queue";

describe("location revocation retry queue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(OneLocationService.stopBackgroundShare).mockResolvedValue(
      {} as never,
    );
    window.localStorage.clear();
  });

  it("quarantines a grant before a failed revoke and clears it after retry", async () => {
    vi.mocked(OneLocationService.revokeGrant)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({} as never);

    await expect(
      revokeLocationGrantOrQueue({
        userId: "owner",
        vaultOwnerToken: "token",
        grantId: "grant-1",
      }),
    ).resolves.toBe(false);
    expect(pendingLocationRevocationGrantIds("owner")).toEqual(
      new Set(["grant-1"]),
    );
    expect(OneLocationService.stopBackgroundShare).toHaveBeenCalledTimes(1);

    await expect(
      retryPendingLocationRevocations({
        userId: "owner",
        vaultOwnerToken: "token",
      }),
    ).resolves.toEqual({
      revokedGrantIds: ["grant-1"],
      pendingGrantIds: [],
    });
    expect(pendingLocationRevocationGrantIds("owner").size).toBe(0);
  });

  it("treats an already absent grant as safely revoked", async () => {
    vi.mocked(OneLocationService.revokeGrant).mockRejectedValueOnce(
      Object.assign(new Error("missing"), { status: 404 }),
    );

    await expect(
      revokeLocationGrantOrQueue({
        userId: "owner",
        vaultOwnerToken: "token",
        grantId: "grant-gone",
      }),
    ).resolves.toBe(true);
    expect(pendingLocationRevocationGrantIds("owner").size).toBe(0);
  });

  it("keeps both per-id records when concurrent tabs overwrite the aggregate index", async () => {
    vi.mocked(OneLocationService.revokeGrant).mockRejectedValue(
      new Error("offline"),
    );

    await Promise.all([
      revokeLocationGrantOrQueue({
        userId: "multi-tab-owner",
        vaultOwnerToken: "token",
        grantId: "grant-tab-a",
      }),
      revokeLocationGrantOrQueue({
        userId: "multi-tab-owner",
        vaultOwnerToken: "token",
        grantId: "grant-tab-b",
      }),
    ]);
    // Reproduce the last-writer-wins aggregate corruption from two tabs. The
    // independent item records remain authoritative and prevent either grant
    // from being published again.
    window.localStorage.setItem(
      pendingLocationRevocationStorageKey("multi-tab-owner"),
      JSON.stringify(["grant-tab-b"]),
    );

    expect(pendingLocationRevocationGrantIds("multi-tab-owner")).toEqual(
      new Set(["grant-tab-b", "grant-tab-a"]),
    );
  });

  it("keeps the grant quarantined in memory when browser storage rejects writes", async () => {
    const storageWrite = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    vi.mocked(OneLocationService.revokeGrant).mockRejectedValueOnce(
      new Error("offline"),
    );

    await revokeLocationGrantOrQueue({
      userId: "private-mode-owner",
      vaultOwnerToken: "token",
      grantId: "grant-private",
    });

    expect(
      pendingLocationRevocationGrantIds("private-mode-owner"),
    ).toEqual(new Set(["grant-private"]));
    storageWrite.mockRestore();
  });

  it("quarantines and retries a public snapshot link that could not be revoked", async () => {
    vi.mocked(OneLocationService.revokePublicInvite)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({} as never);

    await expect(
      revokePublicInviteOrQueue({
        userId: "owner",
        vaultOwnerToken: "token",
        inviteId: "invite-1",
      }),
    ).resolves.toBe(false);
    expect(pendingPublicInviteRevocationIds("owner")).toEqual(
      new Set(["invite-1"]),
    );

    await expect(
      retryPendingPublicInviteRevocations({
        userId: "owner",
        vaultOwnerToken: "token",
      }),
    ).resolves.toEqual({
      revokedInviteIds: ["invite-1"],
      pendingInviteIds: [],
    });
  });
});
