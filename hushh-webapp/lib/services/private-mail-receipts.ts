"use client";
import { ApiService } from './api-service';
import { parseLiveReceiptScanResponse, type ReceiptListItem } from './gmail-receipts-service';
import { privateMailAccounts, type PrivateMailAccount } from './private-google-connections';
import { mergeReceiptSnapshot } from '@/lib/mail/receipt-continuity';
import { loadReceiptSnapshot, receiptStoreGuard, receiptStoreVersion, writeReceiptSnapshot, type ReceiptStoreSession } from '@/lib/mail/receipt-store';
import type { GmailLiveReceiptScanResponse } from './gmail-receipts-service';
import { subscribeDurableOwnerReset, type DurableVersion } from './secure-durable-resource-service';

export type MailboxSyncResult = { accountId: string; status: 'saved' | 'failed' | 'empty'; count: number; partial?: boolean };

/** Explicit foreground sync; one snapshot per mailbox, never an invented "all" account. */
export async function syncPrivateMailReceipts(session: ReceiptStoreSession, selected: readonly PrivateMailAccount[], signal: AbortSignal,
  onResult: (result: MailboxSyncResult) => void): Promise<MailboxSyncResult[]> {
  const ownerCurrent = receiptStoreGuard(session);
  if (!selected.length || selected.length > 20 || new Set(selected.map(a => a.accountId)).size !== selected.length) throw new Error('Choose connected mailboxes.');
  const results: MailboxSyncResult[] = [];
  let reset = false;
  const unsubscribe = subscribeDurableOwnerReset(owner => { if (owner === session.userId) reset = true; });
  const current = () => ownerCurrent() && !reset;
  try {
    const versions = await Promise.all(selected.map(account => receiptStoreVersion(session.userId, account.accountId)));
    for (const [index, account] of selected.entries()) {
      if (!current() || signal.aborted) break;
      let result: MailboxSyncResult;
      try {
        if (account.receiptSyncAvailable !== true || !account.capabilities.read || account.status !== 'connected') throw new Error('Mailbox is unavailable.');
        result = await syncOne(session, account, signal, current, versions[index]!);
      } catch {
        if (!current() || signal.aborted) break;
        result = { accountId: account.accountId, status: 'failed', count: 0 };
      }
      if (!current() || signal.aborted) break;
      results.push(result); onResult(result);
    }
    return results;
  } finally { unsubscribe(); }
}

async function syncOne(session: ReceiptStoreSession, account: PrivateMailAccount, signal: AbortSignal, current: () => boolean, expected: DurableVersion): Promise<MailboxSyncResult> {
  const requireCurrent = () => { if (!current() || signal.aborted) throw new Error('Receipt session changed.'); };
  const previous = await loadReceiptSnapshot(session, account.accountId);
  const items: ReceiptListItem[] = [];
  let cursor: string | null = null;
  let partial = false;
  let lastBatch: GmailLiveReceiptScanResponse | null = null;
  for (let page = 1; page <= 50; page++) {
    requireCurrent();
    const response = await ApiService.ownerPodRequest(`connectors/gmail/accounts/${account.accountId}/receipts/scan`, {
      method: 'POST', signal, body: JSON.stringify({ credential_id: account.credentialId, page, per_page: 6, ...(cursor ? { cursor } : {}) }),
      headers: { 'Content-Type': 'application/json' },
    });
    requireCurrent();
    if (!response.ok) throw new Error('Mailbox receipt scan failed.');
    const batch = parseLiveReceiptScanResponse(await response.json(), { page, perPage: 6 });
    items.push(...batch.items); lastBatch = batch;
    partial = batch.has_more || batch.coverage.reached_limit;
    cursor = batch.next_cursor ?? null;
    if (!batch.has_more) break;
    if (!cursor) throw new Error('Mailbox continuation is missing.');
  }
  requireCurrent();
  const accounts = await privateMailAccounts();
  requireCurrent();
  if (!accounts.some(a => a.accountId === account.accountId && a.credentialId === account.credentialId && a.status === 'connected')) throw new Error('Mailbox connection changed.');
  // An empty read cannot erase a previously verified receipt collection.
  if (!lastBatch || (!items.length && (previous || partial))) return { accountId: account.accountId, status: 'empty', count: 0, partial };
  const snapshot = await mergeReceiptSnapshot(previous?.value ?? null, items, account.accountId, lastBatch, [], !partial);
  requireCurrent();
  await writeReceiptSnapshot({ ...session, isCurrent: () => current() && !signal.aborted, signal }, snapshot, expected);
  requireCurrent();
  return { accountId: account.accountId, status: items.length ? 'saved' : 'empty', count: snapshot.rows.length, partial };
}
