import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/services/kai-profile-sync-service", () => ({
  KaiProfileSyncService: {
    syncPendingToVault: vi.fn(async () => ({ synced: true })),
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

  it("does not seed trusted contacts or connections — return shape is { onboardingSynced } only", async () => {
    const result = await PostUnlockSyncService.run(params);
    // Task 6: seeding removed; return type narrows to { onboardingSynced }.
    expect(Object.keys(result)).toEqual(["onboardingSynced"]);
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
