"use client";
import { DurableResourceError } from "@/lib/services/durable-resource-error";
import { SecureDurableResourceService, type DurableVersion } from "@/lib/services/secure-durable-resource-service";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { analyzeReceipts, type ReceiptFunction } from "./receipt-analysis";
import { receiptAccountBinding, validateReceiptSnapshot, RECEIPT_SNAPSHOT_PREFIX, type ReceiptSnapshot } from "./receipt-snapshot";

export type ReceiptStoreSession = { userId: string; vaultKey: string; vaultOwnerToken: string; isCurrent?: () => boolean };
function guard(session: ReceiptStoreSession) {
  const owner = snapshotValidatedAuthSessionOwner(); const epoch = snapshotVaultSessionEpoch();
  return () => Boolean(session.vaultKey && session.vaultOwnerToken && owner?.userId === session.userId && isValidatedAuthSessionOwnerCurrent(owner) && isVaultSessionEpochCurrent(epoch) && (session.isCurrent?.() ?? true));
}
export async function receiptStoreVersion(userId: string, account: string) {
  return SecureDurableResourceService.version(userId, RECEIPT_SNAPSHOT_PREFIX + await receiptAccountBinding(account));
}
export async function writeReceiptSnapshot(session: ReceiptStoreSession, snapshot: ReceiptSnapshot, expected: DurableVersion) {
  const isCurrent = guard(session);
  if (!session.vaultKey || !session.vaultOwnerToken)
    throw new DurableResourceError("key_unavailable", "authority", "Unlock your vault to save receipts.");
  if (!isCurrent()) throw new DurableResourceError("authority_changed", "authority", "Receipt authority changed.");
  const value = validateReceiptSnapshot(snapshot);
  const resourceKey = RECEIPT_SNAPSHOT_PREFIX + value.account_binding;
  return SecureDurableResourceService.write({ ...session, resourceKey, value, expected, isCurrent,
    validateReadback: validateReceiptSnapshot });
}
export async function loadReceiptSnapshot(session: ReceiptStoreSession, account: string | null) {
  const isCurrent = guard(session); if (!isCurrent()) throw new Error("Unlock your vault to read saved receipts.");
  const keys = account ? [RECEIPT_SNAPSHOT_PREFIX + await receiptAccountBinding(account)] : await SecureDurableResourceService.list(session.userId, RECEIPT_SNAPSHOT_PREFIX);
  const values = [];
  for (const key of keys) {
    const item = await SecureDurableResourceService.read<ReceiptSnapshot>(session.userId, key, session.vaultKey);
    if (!isCurrent()) throw new Error("Receipt authority changed.");
    if (item) {
      const value = validateReceiptSnapshot(item.value);
      if (key !== RECEIPT_SNAPSHOT_PREFIX + value.account_binding) throw new Error("Receipt account binding is invalid.");
      values.push({ ...item, value });
    }
  }
  // No account is selected after disconnect: display the owner's latest saved
  // Mail snapshot. Do not combine different Mail accounts into analytics.
  return values.sort((a, b) => b.value.freshness.localeCompare(a.value.freshness))[0] ?? null;
}
export async function runReceiptFunction(session: ReceiptStoreSession, operation: ReceiptFunction, request: unknown, account: string | null = null) {
  const isCurrent = guard(session);
  const snapshot = await loadReceiptSnapshot({ ...session, isCurrent }, account);
  if (!snapshot) throw new Error("No saved receipt snapshot is available. Open Mail Receipts and sync first.");
  const result = analyzeReceipts(operation, request, snapshot.value, snapshot.revision);
  if (!isCurrent()) throw new Error("Receipt authority changed.");
  const current = await SecureDurableResourceService.version(session.userId, RECEIPT_SNAPSHOT_PREFIX + snapshot.value.account_binding);
  if (!isCurrent()) throw new Error("Receipt authority changed.");
  if (current.generation !== snapshot.generation || current.revision !== snapshot.revision) throw new Error("Saved receipts changed. Ask again.");
  if (new TextEncoder().encode(JSON.stringify(result)).length > 64 * 1024) throw new Error("Receipt result exceeded the turn limit. Request a smaller range.");
  return result;
}
