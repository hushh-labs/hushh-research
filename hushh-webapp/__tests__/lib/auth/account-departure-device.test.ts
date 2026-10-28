import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rememberPendingAccountDeviceDeparture, purgeConfirmedAccountDeviceDeparture } from "@/lib/auth/account-departure-device";
import type { AccountCleanupOperation } from "@/lib/auth/account-cleanup-operation";

const mocks = vi.hoisted(() => ({
  clearForUser: vi.fn().mockResolvedValue(undefined),
  clearDeviceSecrets: vi.fn().mockResolvedValue(undefined),
  onAccountDeleted: vi.fn(),
}));
vi.mock("@/lib/services/user-local-state-service", () => ({ UserLocalStateService: {
  clearForUser: mocks.clearForUser,
  clearDeviceSecretsForDeletedAccount: mocks.clearDeviceSecrets,
} }));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: { onAccountDeleted: mocks.onAccountDeleted } }));

const owner = "acct_" + "d".repeat(32);
const operationId = "b99efb85-c1f2-4714-8a63-614d774a25a3";
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const complete: AccountCleanupOperation = {
  id: operationId, state: "complete", credential_count: 1,
  local_erasure_confirmation_required: false, external_validity_unconfirmed_count: 0,
  inventory_sha256: "a".repeat(64), retry_after_seconds: null, owner_hash: hash(owner),
};

describe("completed account device departure", () => {
  beforeEach(() => { window.localStorage.clear(); vi.clearAllMocks(); });

  it("keeps the hint sealed until the same identity, operation and owner hash complete", async () => {
    rememberPendingAccountDeviceDeparture("firebase-a", owner, operationId);
    expect(await purgeConfirmedAccountDeviceDeparture("firebase-b", complete)).toBe(false);
    expect(await purgeConfirmedAccountDeviceDeparture("firebase-a", { ...complete, state: "cleaning_up" })).toBe(false);
    expect(await purgeConfirmedAccountDeviceDeparture("firebase-a", { ...complete, id: "86f55df8-4527-49e4-81f7-62d9ac3dde7a" })).toBe(false);
    expect(await purgeConfirmedAccountDeviceDeparture("firebase-a", { ...complete, owner_hash: hash("acct_" + "e".repeat(32)) })).toBe(false);
    expect(mocks.clearForUser).not.toHaveBeenCalled();
    expect(await purgeConfirmedAccountDeviceDeparture("firebase-a", complete)).toBe(true);
    expect(mocks.clearForUser).toHaveBeenCalledWith(owner, { deleteDurableReceipts: true });
    expect(mocks.clearDeviceSecrets).toHaveBeenCalledWith(owner);
    expect(mocks.onAccountDeleted).toHaveBeenCalledWith(owner);
    expect(await purgeConfirmedAccountDeviceDeparture("firebase-a", complete)).toBe(false);
  });

  it("retains the hint for retry if local receipt removal fails", async () => {
    rememberPendingAccountDeviceDeparture("firebase-a", owner, operationId);
    mocks.clearForUser.mockRejectedValueOnce(new Error("device unavailable"));
    await expect(purgeConfirmedAccountDeviceDeparture("firebase-a", complete)).rejects.toThrow("device unavailable");
    expect(await purgeConfirmedAccountDeviceDeparture("firebase-a", complete)).toBe(true);
    expect(mocks.clearForUser).toHaveBeenCalledTimes(2);
  });
});
