import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { SecureDurableResourceService as Durable } from "@/lib/services/secure-durable-resource-service";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { loadReceiptSnapshot, receiptStoreVersion, writeReceiptSnapshot } from "@/lib/mail/receipt-store";
import { captureReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import { MailReceiptResourceService as Resource } from "@/lib/services/mail-receipt-resource-service";
import type { GmailLiveReceiptScanResponse } from "@/lib/services/gmail-receipts-service";
import { syncPrivateMailReceipts } from "@/lib/services/private-mail-receipts";
import { ApiService } from "@/lib/services/api-service";
import * as connections from "@/lib/services/private-google-connections";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

import { buildReceiptAccountReport } from "@/lib/mail/receipt-account-report";
import { listSavedReceiptAccounts, runSavedReceiptReport } from "@/lib/mail/receipt-report-store";
const key = "12".repeat(32);
const coverage = { partial: false, truncated: false, source_count: 3, window_from: null, window_to: null, source: "gmail_live" as const };
const receipt = (id: number, extra: Partial<ReceiptListItem> = {}): ReceiptListItem => ({
  id, source_id: `gmail_live_RAW_MESSAGE_${id}`, receipt_key: `gmail_live_RAW_MESSAGE_${id}`, source_kind: "gmail_live",
  gmail_message_id: `RAW_MESSAGE_${id}`, gmail_thread_id: "RAW_THREAD", subject: "RAW_SUBJECT", from_name: "RAW_SENDER", from_email: "raw@example.com", preview: "RAW_BODY", snippet: "RAW_SNIPPET", cleaned_preview: "RAW_PASSAGE", short_detail: "RAW_DETAIL",
  source_evidence: [{ kind: "amount", text: "RAW_EVIDENCE" }], merchant_name: "Amazon", merchant_domain: "amazon.com", sender_domain: "amazon.com",
  category: "Shopping", category_confidence: 0.99, status: "paid", event_type: "purchase", document_kind: "receipt",
  amount: 0.1, amount_decimal: "0.10", currency: "USD", transaction_date: "2026-10-01T12:00:00Z", identifiers: [{ kind: "order", value: `ORDER-${id}` }], ...extra,
});
afterEach(() => { Resource.clear("owner"); vi.useRealTimers(); });
beforeEach(() => { Resource.clear("owner"); vi.restoreAllMocks(); publishValidatedAuthSessionOwner("owner"); Object.defineProperty(window, "indexedDB", { value: new IDBFactory(), configurable: true }); Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }); });

const reportRequest = { from_date: "2026-10-01", to_date: "2026-11-01", timezone: "Asia/Kolkata", recurring_only: false };
const reportSession = { userId: "owner", vaultKey: key, vaultOwnerToken: "owner-token" };
async function saveMailbox(account: string, items: ReceiptListItem[]) {
  const snapshot = await captureReceiptSnapshot(items, account, coverage);
  await writeReceiptSnapshot(reportSession, snapshot, await receiptStoreVersion("owner", account));
  return snapshot;
}

describe("explicit multi-mailbox saved receipt reports", () => {
  it("combines selected accounts, removes a confirmed forwarded copy and keeps exact currencies separate", async () => {
    const work = await saveMailbox("work", [receipt(1, { recurrence: "recurring" })]);
    const personal = await saveMailbox("personal", [
      receipt(11, { identifiers: [{ kind: "order", value: "ORDER-1" }], recurrence: "recurring" }),
      receipt(2, { amount: 0.2, amount_decimal: "0.20", recurrence: "recurring" }),
      receipt(3, { amount: 30, amount_decimal: "30.00", currency: "INR", recurrence: "one_time" }),
    ]);
    const result = await runSavedReceiptReport(reportSession, "all_saved", reportRequest);
    expect(result.totals).toEqual([{ currency: "INR", paid_amount: "30.00" }, { currency: "USD", paid_amount: "0.30" }]);
    expect(result.duplicate_copies_removed).toBe(1);
    expect(result.accounts.map(account => account.binding).sort()).toEqual([work.account_binding, personal.account_binding].sort());
    expect(await listSavedReceiptAccounts(reportSession)).toHaveLength(2);
    const selected = await runSavedReceiptReport(reportSession, [work.account_binding], reportRequest);
    expect(selected.totals).toEqual([{ currency: "USD", paid_amount: "0.10" }]);
    const recurring = await runSavedReceiptReport(reportSession, "all_saved", { ...reportRequest, recurring_only: true });
    expect(recurring.totals).toEqual([{ currency: "USD", paid_amount: "0.30" }]);
  });
  it("excludes conflicting lifecycle evidence instead of counting an old paid copy", async () => {
    const paid = await captureReceiptSnapshot([receipt(1)], "work", coverage);
    const refunded = await captureReceiptSnapshot([receipt(2, { identifiers: [{ kind: "order", value: "ORDER-1" }],
      status: "refunded", event_type: "refund", transaction_date: "2026-11-10" })], "personal", coverage);
    const result = buildReceiptAccountReport(reportRequest, [{ snapshot: paid, revision: 1 }, { snapshot: refunded, revision: 1 }]);
    expect(result.conflicting_records_excluded).toBe(2);
    expect(result.totals).toEqual([]);
    expect(result.charges).toEqual([]);
  });
  it("never merges by merchant and price alone or invents dates, and preserves partial coverage", async () => {
    const work = await captureReceiptSnapshot([receipt(1, { identifiers: [], recurrence: "recurring" })], "work", coverage);
    const personal = await captureReceiptSnapshot([receipt(2, { identifiers: [], recurrence: "recurring" }),
      receipt(3, { transaction_date: "October 1", recurrence: "recurring" })], "personal", { ...coverage, partial: true });
    const result = buildReceiptAccountReport(reportRequest, [{ snapshot: work, revision: 1 }, { snapshot: personal, revision: 2 }]);
    expect(result.totals).toEqual([{ currency: "USD", paid_amount: "0.20" }]);
    expect(result.unidentified_records).toBe(2);
    expect(result.undated_records_excluded).toBe(1);
    expect(result.accounts[1]).toMatchObject({ revision: 2, coverage: { partial: true } });
    expect(result.duplicate_copies_removed).toBe(0);
  });
  it("refuses a missing selected account instead of returning a partial total", async () => {
    const work = await saveMailbox("work", [receipt(1)]);
    await expect(runSavedReceiptReport(reportSession, [work.account_binding, "f".repeat(64)], reportRequest)).rejects.toThrow(/changed/);
    await expect(runSavedReceiptReport(reportSession, [work.account_binding, work.account_binding], reportRequest)).rejects.toThrow(/valid/);
  });
  it("never collapses two canonical invoice charges through a shared cross-mailbox order reference", async () => {
    const work = await captureReceiptSnapshot([receipt(1), receipt(2)], "work", coverage);
    work.rows[0]!.identifiers = [{ kind: "order", value: "SHARED" }, { kind: "invoice", value: "I1" }];
    work.rows[1]!.identifiers = [{ kind: "order", value: "SHARED" }, { kind: "invoice", value: "I2" }];
    const personal = await captureReceiptSnapshot([receipt(11)], "personal", coverage);
    personal.rows[0]!.identifiers = [...work.rows[0]!.identifiers];
    const result = buildReceiptAccountReport(reportRequest, [{ snapshot: work, revision: 1 }, { snapshot: personal, revision: 1 }]);
    expect(result.conflicting_records_excluded).toBe(3);
    expect(result.duplicate_copies_removed).toBe(0);
    expect(result.totals).toEqual([]);
  });
  it("rechecks every account revision and fails closed if any input changed", async () => {
    await saveMailbox("work", [receipt(1)]); await saveMailbox("personal", [receipt(2)]);
    const version = Durable.version.bind(Durable);
    vi.spyOn(Durable, "version").mockImplementation(async (...args) => {
      const result = await version(...args); return { ...result, revision: result.revision + 1 };
    });
    await expect(runSavedReceiptReport(reportSession, "all_saved", reportRequest)).rejects.toThrow(/changed/);
  });
  it("rejects an owner change while accounts are being read", async () => {
    await saveMailbox("work", [receipt(1)]);
    const read = Durable.read.bind(Durable);
    vi.spyOn(Durable, "read").mockImplementation(async (...args) => {
      const result = await read(...args); publishValidatedAuthSessionOwner("another-owner"); return result;
    });
    await expect(runSavedReceiptReport(reportSession, "all_saved", reportRequest)).rejects.toThrow(/authority/);
  });
});

const accounts: connections.PrivateMailAccount[] = ['a', 'b'].map((letter, index) => ({
  accountId: letter.repeat(32), credentialId: `${index + 1}1111111-2222-4333-8444-555555555555`,
  email: `${letter}@example.com`, provider: 'google', connectorId: 'gmail', status: 'connected',
  isDefault: index === 0, accessLevel: 'read', capabilities: { read: true, manage: false }, receiptSyncAvailable: true,
}));
function livePage(items: ReceiptListItem[]): GmailLiveReceiptScanResponse {
  return { items: items.map(item => ({ ...item, source_kind: 'gmail_live', event_id: String(item.id).repeat(64),
    order_id: null, receipt_date: null, gmail_internal_date: '2026-10-01T12:00:00Z', classification_source: 'agent', classification_confidence: 0.99,
  })) as GmailLiveReceiptScanResponse['items'], page: 1, per_page: 6, returned_count: items.length, has_more: false,
    coverage: { source: 'gmail_live', listed_count: items.length, candidate_count: items.length, matched_count: items.length,
      pages_scanned: 1, max_messages: 6, max_pages: 50, reached_limit: false,
      window_start: '2025-10-23T00:00:00Z', window_end: '2026-10-23T00:00:00Z', query_scope: 'receipt_signals_all_mail_except_spam_trash',
      rejection_counts: { missing_receipt_signal: 0, extractor_not_receipt: 0 },
      evidence_counts: { gmail_category: 0, subject_signal: items.length, body_signal: 0, verified_merchant: 0, order_candidate: 0, total_candidate: 0 } } };
}
function scanFixture(answer: (route: string, init?: RequestInit) => Promise<Response>) {
  vi.spyOn(connections, 'privateMailAccounts').mockResolvedValue(accounts);
  return vi.spyOn(ApiService, 'ownerPodRequest').mockImplementation(answer);
}
describe('foreground mailbox receipt boundaries', () => {
  it('saves verified zero coverage and combines it with a populated mailbox', async () => {
    const scan = scanFixture(async route => Response.json(livePage(route.includes(accounts[0]!.accountId) ? [] : [receipt(2)])));
    const result = await syncPrivateMailReceipts(reportSession, accounts, new AbortController().signal, () => {});
    expect(result.map(item => item.status)).toEqual(['empty', 'saved']);
    const report = await runSavedReceiptReport(reportSession, 'all_saved', reportRequest);
    expect(report.accounts).toHaveLength(2);
    expect(report.totals).toEqual([{ currency: 'USD', paid_amount: '0.10' }]);
    expect(JSON.parse(scan.mock.calls[1]![1]!.body as string).credential_id).toBe(accounts[1]!.credentialId);
  });
  it('keeps older receipts on a later nonempty scan, and keeps another account on failure', async () => {
    await saveMailbox(accounts[0]!.accountId, [receipt(1)]);
    await saveMailbox(accounts[1]!.accountId, [receipt(3)]);
    scanFixture(async route => route.includes(accounts[0]!.accountId) ? Response.json(livePage([receipt(2)])) : new Response(null, { status: 503 }));
    const result = await syncPrivateMailReceipts(reportSession, accounts, new AbortController().signal, () => {});
    expect(result.map(item => item.status)).toEqual(['saved', 'failed']);
    expect((await loadReceiptSnapshot(reportSession, accounts[0]!.accountId))!.value.rows).toHaveLength(2);
    expect((await loadReceiptSnapshot(reportSession, accounts[1]!.accountId))!.revision).toBe(1);
  });
  it('does not scan the next mailbox or repopulate receipts after owner Reset', async () => {
    let release!: (response: Response) => void;
    const scan = scanFixture(async () => new Promise(resolve => { release = resolve; }));
    const sync = syncPrivateMailReceipts(reportSession, accounts, new AbortController().signal, () => {});
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
    await Durable.purgeUser('owner'); release(Response.json(livePage([receipt(2)])));
    expect(await sync).toEqual([]);
    expect(scan).toHaveBeenCalledOnce();
    expect(await listSavedReceiptAccounts(reportSession)).toEqual([]);
  });
  it('refuses a changed mailbox credential before publishing any scanned rows', async () => {
    scanFixture(async () => Response.json(livePage([receipt(2)])));
    vi.mocked(connections.privateMailAccounts).mockResolvedValue([{ ...accounts[0]!, credentialId: accounts[1]!.credentialId }]);
    expect(await syncPrivateMailReceipts(reportSession, [accounts[0]!], new AbortController().signal, () => {})).toMatchObject([{ status: 'failed' }]);
    expect(await listSavedReceiptAccounts(reportSession)).toEqual([]);
  });
});
