"use client";
import { DurableResourceError } from "@/lib/services/durable-resource-error";
import { SecureDurableResourceService, type DurableVersion } from "@/lib/services/secure-durable-resource-service";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { analyzeReceipts, type ReceiptFunction } from "./receipt-analysis";
import { receiptAccountBinding, validateReceiptSnapshot, RECEIPT_SNAPSHOT_PREFIX, LEGACY_RECEIPT_SNAPSHOT_PREFIX, type ReceiptSnapshot } from "./receipt-snapshot";

export type ReceiptStoreSession = { userId: string; vaultKey: string; vaultOwnerToken: string; isCurrent?: () => boolean; signal?: AbortSignal };
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
type StoredReceipt = DurableVersion & { value: ReceiptSnapshot; source: DurableVersion & { resourceKey: string } };
async function readSnapshot(session: ReceiptStoreSession, key: string, prefix: string, isCurrent: () => boolean): Promise<StoredReceipt | null> {
  const targetKey = RECEIPT_SNAPSHOT_PREFIX + key.slice(prefix.length);
  // Capture before the legacy read: a concurrent V2 commit must reject a stale
  // migration rather than lend its revision to an older display snapshot.
  const target = prefix === LEGACY_RECEIPT_SNAPSHOT_PREFIX
    ? await SecureDurableResourceService.version(session.userId, targetKey) : null;
  if (target?.revision) return readSnapshot(session, targetKey, RECEIPT_SNAPSHOT_PREFIX, isCurrent);
  const item = await SecureDurableResourceService.read<ReceiptSnapshot>(session.userId, key, session.vaultKey, isCurrent);
  if (!isCurrent()) throw new Error("Receipt authority changed.");
  if (!item) return null;
  const value = validateReceiptSnapshot(item.value);
  if (key !== prefix + value.account_binding) throw new Error("Receipt account binding is invalid.");
  return { ...item, ...target, value, source: { resourceKey: key, generation: item.generation, revision: item.revision } };
}
export async function loadReceiptSnapshot(session: ReceiptStoreSession, account: string | null): Promise<StoredReceipt | null> {
  const isCurrent = guard(session); if (!isCurrent()) throw new Error("Unlock your vault to read saved receipts.");
  const binding = account ? await receiptAccountBinding(account) : null;
  // V2 is authoritative once present. Keep V1 untouched for old bundles and
  // rollback; their later writes cannot replace accumulated V2 receipts.
  for (const prefix of [RECEIPT_SNAPSHOT_PREFIX, LEGACY_RECEIPT_SNAPSHOT_PREFIX]) {
    const keys = binding ? [prefix + binding] : await SecureDurableResourceService.list(session.userId, prefix);
    const values: StoredReceipt[] = [];
    for (const key of keys) {
      const item = await readSnapshot(session, key, prefix, isCurrent);
      if (item) values.push(item);
    }
    const preferred = values.filter(item => item.source.resourceKey.startsWith(RECEIPT_SNAPSHOT_PREFIX));
    // Disconnected: select one account's latest snapshot, never merge accounts.
    const latest = (preferred.length ? preferred : values).sort((a, b) => b.value.freshness.localeCompare(a.value.freshness))[0];
    if (latest) return latest;
  }
  return null;
}
export async function runReceiptFunction(session: ReceiptStoreSession, operation: ReceiptFunction, request: unknown, account: string | null = null) {
  const isCurrent = guard(session);
  const snapshot = await loadReceiptSnapshot({ ...session, isCurrent }, account);
  if (!snapshot) throw new Error("No saved receipt snapshot is available. Open Mail Receipts and sync first.");
  const result = analyzeReceipts(operation, request, snapshot.value, snapshot.source.revision);
  if (!isCurrent()) throw new Error("Receipt authority changed.");
  const current = await SecureDurableResourceService.version(session.userId, RECEIPT_SNAPSHOT_PREFIX + snapshot.value.account_binding);
  if (!isCurrent()) throw new Error("Receipt authority changed.");
  if (current.generation !== snapshot.generation || current.revision !== snapshot.revision) throw new Error("Saved receipts changed. Ask again.");
  const source = await SecureDurableResourceService.version(session.userId, snapshot.source.resourceKey);
  if (!isCurrent() || source.generation !== snapshot.source.generation || source.revision !== snapshot.source.revision) throw new Error("Saved receipts changed. Ask again.");
  if (new TextEncoder().encode(JSON.stringify(result)).length > 64 * 1024) throw new Error("Receipt result exceeded the turn limit. Request a smaller range.");
  return result;
}
