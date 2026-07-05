import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/services/kai-profile-sync-service", () => ({
  KaiProfileSyncService: {
    syncPendingToVault: vi.fn(async () => ({ synced: true })),
  },
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    seedTrustedContacts: vi.fn(async () => ({
      seeded: 3,
      existingCount: 0,
      skippedSelf: 0,
    })),
  },
}));

vi.mock("@/lib/one-connections/service", () => ({
  OneConnectionsService: {
    seedTrustedConnections: vi.fn(async () => ({
      seeded: 0,
      existingCount: 0,
      skippedSelf: 0,
    })),
  },
}));

import { PostUnlockSyncService } from "@/lib/services/post-unlock-sync-service";
import { OneLocationService } from "@/lib/one-location/service";

const params = { userId: "u1", vaultKey: "vk", vaultOwnerToken: "tok" };

beforeEach(() => vi.clearAllMocks());

describe("PostUnlockSyncService SOS seed", () => {
  it("calls seedTrustedContacts and reports sosSeeded", async () => {
    const result = await PostUnlockSyncService.run(params);
    expect(OneLocationService.seedTrustedContacts).toHaveBeenCalledWith({
      vaultOwnerToken: "tok",
    });
    expect(result.sosSeeded).toBe(true);
    expect(result.onboardingSynced).toBe(true);
  });

  it("does not throw when seeding fails", async () => {
    (OneLocationService.seedTrustedContacts as unknown as vi.Mock).mockRejectedValueOnce(
      new Error("boom"),
    );
    const result = await PostUnlockSyncService.run(params);
    expect(result.sosSeeded).toBe(false);
    expect(result.onboardingSynced).toBe(true);
  });
});
