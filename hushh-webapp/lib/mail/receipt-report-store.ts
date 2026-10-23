"use client";
import { SecureDurableResourceService as Durable } from "@/lib/services/secure-durable-resource-service";
import { receiptStoreGuard, type ReceiptStoreSession } from "./receipt-store";
import { RECEIPT_SNAPSHOT_PREFIX, validateReceiptSnapshot, type ReceiptSnapshot } from "./receipt-snapshot";
import { buildReceiptAccountReport, type ReceiptReportRequest } from "./receipt-account-report";

export type SavedReceiptAccount = { binding: string; freshness: string; count: number; partial: boolean };
export type ReceiptReportScope = "all_saved" | readonly string[];
const BINDING = /^[a-f0-9]{48,64}$/;

async function snapshotKeys(session: ReceiptStoreSession, isCurrent: () => boolean) {
  const keys = (await Durable.list(session.userId, RECEIPT_SNAPSHOT_PREFIX)).sort();
  if (!isCurrent()) throw new Error("Receipt authority changed.");
  if (keys.some(key => !BINDING.test(key.slice(RECEIPT_SNAPSHOT_PREFIX.length)))) throw new Error("Invalid receipt account.");
  return keys;
}

async function readSnapshot(session: ReceiptStoreSession, key: string, isCurrent: () => boolean) {
  const item = await Durable.read<ReceiptSnapshot>(session.userId, key, session.vaultKey);
  if (!isCurrent()) throw new Error("Receipt authority changed.");
  if (!item) throw new Error("Saved receipts changed. Refresh the report.");
  const snapshot = validateReceiptSnapshot(item.value);
  if (key !== RECEIPT_SNAPSHOT_PREFIX + snapshot.account_binding) throw new Error("Receipt account binding is invalid.");
  return { ...item, snapshot, key };
}

/** Metadata is decrypted only inside the existing validated owner/vault session. */
export async function listSavedReceiptAccounts(session: ReceiptStoreSession): Promise<SavedReceiptAccount[]> {
  const isCurrent = receiptStoreGuard(session);
  if (!isCurrent()) throw new Error("Unlock your vault to read saved receipts.");
  const keys = await snapshotKeys(session, isCurrent);
  if (keys.length > 20) throw new Error("Too many saved mailboxes for this report.");
  const accounts: SavedReceiptAccount[] = [];
  for (const key of keys) {
    const { snapshot } = await readSnapshot(session, key, isCurrent);
    accounts.push({ binding: snapshot.account_binding, freshness: snapshot.freshness,
      count: snapshot.rows.length, partial: snapshot.coverage.partial || snapshot.coverage.truncated });
  }
  return accounts;
}

/** Every selected account is required and rechecked; a failed account never becomes zero. */
export async function runSavedReceiptReport(session: ReceiptStoreSession, scope: ReceiptReportScope, request: ReceiptReportRequest) {
  const isCurrent = receiptStoreGuard(session);
  if (!isCurrent()) throw new Error("Unlock your vault to read saved receipts.");
  if (scope !== "all_saved" && (!Array.isArray(scope) || !scope.length || scope.length > 20 ||
      new Set(scope).size !== scope.length || scope.some(binding => !BINDING.test(binding)))) throw new Error("Choose valid saved mailboxes.");
  const keys = scope === "all_saved" ? await snapshotKeys(session, isCurrent) : scope.map(binding => RECEIPT_SNAPSHOT_PREFIX + binding).sort();
  if (!keys.length) throw new Error("No saved receipts yet. Sync a connected mailbox first.");
  if (keys.length > 20) throw new Error("Choose at most twenty saved mailboxes.");
  const snapshots = [];
  for (const key of keys) snapshots.push(await readSnapshot(session, key, isCurrent));
  const report = buildReceiptAccountReport(request, snapshots);
  for (const snapshot of snapshots) {
    const current = await Durable.version(session.userId, snapshot.key);
    if (!isCurrent()) throw new Error("Receipt authority changed.");
    if (current.generation !== snapshot.generation || current.revision !== snapshot.revision)
      throw new Error("Saved receipts changed. Refresh the report.");
  }
  if (scope === "all_saved" && JSON.stringify(await snapshotKeys(session, isCurrent)) !== JSON.stringify(keys))
    throw new Error("Saved mailboxes changed. Refresh the report.");
  if (!isCurrent()) throw new Error("Receipt authority changed.");
  return report;
}
