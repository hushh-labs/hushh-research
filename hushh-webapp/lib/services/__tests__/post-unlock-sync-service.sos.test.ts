import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/services/kai-profile-sync-service", () => ({
  KaiProfileSyncService: {
    syncPendingToVault: vi.fn(async () => ({ synced: true })),
  },
}));

const kycDraftMocks = vi.hoisted(() => ({
  flushIdentityDraft: vi.fn(async () => false),
}));

vi.mock("@/lib/services/kyc-identity-profile-pkm-service", () => ({
  KycIdentityProfileDraftService: {
    flushToVault: kycDraftMocks.flushIdentityDraft,
  },
}));

import { PostUnlockSyncService } from "@/lib/services/post-unlock-sync-service";

const params = { userId: "u1", vaultKey: "vk", vaultOwnerToken: "tok" };

beforeEach(() => vi.clearAllMocks());

describe("PostUnlockSyncService", () => {
  it("still syncs onboarding to vault", async () => {
    const result = await PostUnlockSyncService.run(params);
    expect(result.onboardingSynced).toBe(true);
  });

  it("does not seed trusted contacts or connections and reports only setup synchronization", async () => {
    const result = await PostUnlockSyncService.run(params);
    expect(Object.keys(result).sort()).toEqual([
      "kycIdentitySynced",
      "onboardingSynced",
    ]);
  });

  it("flushes a staged KYC profile only after vault authority exists", async () => {
    kycDraftMocks.flushIdentityDraft.mockResolvedValueOnce(true);
    await expect(PostUnlockSyncService.run(params)).resolves.toMatchObject({
      kycIdentitySynced: true,
    });
    expect(kycDraftMocks.flushIdentityDraft).toHaveBeenCalledWith(params);
  });

  it("onboardingSynced is false when vault sync fails", async () => {
    const { KaiProfileSyncService } = await import("@/lib/services/kai-profile-sync-service");
    (
      KaiProfileSyncService.syncPendingToVault as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("vault boom"));
    const result = await PostUnlockSyncService.run(params);
    expect(result.onboardingSynced).toBe(false);
  });
});
