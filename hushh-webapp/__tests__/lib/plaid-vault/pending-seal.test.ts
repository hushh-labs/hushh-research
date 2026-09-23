import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, unknown>());
const client = vi.hoisted(() => ({ removeVaultItem: vi.fn() }));

vi.mock("@/lib/kai/plaid-vault/vault-client", () => client);
vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {
    // Stands in for the vault-key-encrypted IndexedDB record.
    read: vi.fn(async ({ userId, resourceKey }: { userId: string; resourceKey: string }) =>
      store.get(`${userId}:${resourceKey}`) ?? null,
    ),
    writeRequired: vi.fn(
      async ({ userId, resourceKey, value }: { userId: string; resourceKey: string; value: unknown }) => {
        store.set(`${userId}:${resourceKey}`, value);
      },
    ),
    invalidateResource: vi.fn(async (userId: string, resourceKey: string) => {
      store.delete(`${userId}:${resourceKey}`);
    }),
  },
}));

import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";
import { clearPendingSeal, recordPendingSeal, recoverPendingSeals } from "@/lib/kai/plaid-vault/pending-seal";

const OWNER = { userId: "owner", vaultKey: "vk" };
const TOKEN = "access-sandbox-orphan-0001";

describe("orphan guard for sealed Plaid connections", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    client.removeVaultItem.mockResolvedValue({ removed: true });
  });

  it("keeps the token only in the encrypted record, and clears it once sealed", async () => {
    await recordPendingSeal({ ...OWNER, itemId: "item_1", accessToken: TOKEN });
    expect(vi.mocked(SecureResourceCacheService.writeRequired)).toHaveBeenCalledWith(
      expect.objectContaining({ vaultKey: "vk" }),
    );

    await clearPendingSeal({ ...OWNER, itemId: "item_1" });
    expect(store.size).toBe(0);
  });

  it("disconnects a link the app never finished saving", async () => {
    await recordPendingSeal({ ...OWNER, itemId: "item_1", accessToken: TOKEN });

    const outcome = await recoverPendingSeals({
      ...OWNER,
      vaultOwnerToken: "vot",
      sealedItemIds: new Set(),
    });

    expect(outcome).toEqual({ disconnected: 1, alreadySealed: 0, failed: 0 });
    expect(client.removeVaultItem).toHaveBeenCalledWith({ vaultOwnerToken: "vot", accessToken: TOKEN });
    expect(store.size).toBe(0);
  });

  it("leaves a connection that did reach the vault alone", async () => {
    await recordPendingSeal({ ...OWNER, itemId: "item_1", accessToken: TOKEN });

    const outcome = await recoverPendingSeals({
      ...OWNER,
      vaultOwnerToken: "vot",
      sealedItemIds: new Set(["item_1"]),
    });

    expect(outcome).toEqual({ disconnected: 0, alreadySealed: 1, failed: 0 });
    expect(client.removeVaultItem).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("keeps an orphan for the next unlock when Plaid cannot be reached", async () => {
    await recordPendingSeal({ ...OWNER, itemId: "item_1", accessToken: TOKEN });
    client.removeVaultItem.mockRejectedValueOnce(new Error("offline"));

    const outcome = await recoverPendingSeals({
      ...OWNER,
      vaultOwnerToken: "vot",
      sealedItemIds: new Set(),
    });

    expect(outcome.failed).toBe(1);
    expect(store.size).toBe(1);
  });

  it("does nothing when no link is pending", async () => {
    const outcome = await recoverPendingSeals({ ...OWNER, vaultOwnerToken: "vot", sealedItemIds: new Set() });

    expect(outcome).toEqual({ disconnected: 0, alreadySealed: 0, failed: 0 });
    expect(client.removeVaultItem).not.toHaveBeenCalled();
  });
});
