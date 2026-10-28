"use client";

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { UserLocalStateService } from "@/lib/services/user-local-state-service";
import type { AccountCleanupOperation } from "./account-cleanup-operation";
import type { AuthSessionInvalidationCode } from "./session-invalidation";

const DEPARTED_ACCOUNT_CODES: ReadonlySet<AuthSessionInvalidationCode> = new Set([
  "account_not_found", "account_deleted", "account_deleted_ready_to_start_fresh",
  "account_deletion_finishing", "account_deletion_identity_retained",
]);

/**
 * The backend or Firebase confirmed this account is gone (never an uncertain
 * outcome or a disabled account), so the device key material it owned goes too.
 * Durable device copies follow only a backend-confirmed erasure, never the
 * broader Firebase account_not_found.
 */
export function purgeDepartedAccountDevice(ownerId: string, code: AuthSessionInvalidationCode): void {
  if (!DEPARTED_ACCOUNT_CODES.has(code)) return;
  void UserLocalStateService.clearDeviceSecretsForDeletedAccount(ownerId);
  if (code === "account_not_found") return;
  CacheSyncService.onAccountDeleted(ownerId);
  void UserLocalStateService.clearForUser(ownerId, {
    deleteDurableReceipts: true,
  }).catch((error: unknown) => {
    console.warn("[AuthProvider] Deleted-account device cleanup incomplete:", error);
  });
}

type DepartureHint = { firebaseUid: string; ownerId: string; operationId: string };
const KEY_PREFIX = "hushh.accountDeparture.v1.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function key(firebaseUid: string): string { return `${KEY_PREFIX}${encodeURIComponent(firebaseUid)}`; }

function read(firebaseUid: string): DepartureHint | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(key(firebaseUid)) ?? "null");
    if (value?.firebaseUid !== firebaseUid || typeof value.ownerId !== "string" || !value.ownerId || value.ownerId.length > 128 ||
        typeof value.operationId !== "string" || !UUID.test(value.operationId)) return null;
    return value as DepartureHint;
  } catch { return null; }
}

/** Store only identifiers. No token, key, phone number, or decrypted information. */
export function rememberPendingAccountDeviceDeparture(firebaseUid: string, ownerId: string, operationId: string): void {
  if (typeof window === "undefined" || !firebaseUid || firebaseUid.length > 128 || !ownerId || ownerId.length > 128 || !UUID.test(operationId)) return;
  try { window.localStorage.setItem(key(firebaseUid), JSON.stringify({ firebaseUid, ownerId, operationId })); }
  catch { /* Auth must still leave a tombstoned account even if storage is unavailable. */ }
}

/** A completed, identity-bound exact operation authorizes purging only its own device owner. */
export async function purgeConfirmedAccountDeviceDeparture(firebaseUid: string, operation: AccountCleanupOperation): Promise<boolean> {
  const hint = read(firebaseUid);
  if (!hint || operation.state !== "complete" || operation.id !== hint.operationId || !operation.owner_hash || !globalThis.crypto?.subtle) return false;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(hint.ownerId));
  const ownerHash = `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  if (ownerHash !== operation.owner_hash) return false;
  await UserLocalStateService.clearForUser(hint.ownerId, { deleteDurableReceipts: true });
  await UserLocalStateService.clearDeviceSecretsForDeletedAccount(hint.ownerId);
  CacheSyncService.onAccountDeleted(hint.ownerId);
  if (read(firebaseUid)?.operationId === hint.operationId) {
    window.localStorage.removeItem(key(firebaseUid));
  }
  return true;
}
