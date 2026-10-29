import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { SecureDurableResourceService as Durable } from "@/lib/services/secure-durable-resource-service";
import { openSecureResourceDb, DURABLE_RESOURCE_STORE } from "@/lib/services/secure-resource-cache-service";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { loadReceiptSnapshot, receiptStoreVersion, runReceiptFunction, writeReceiptSnapshot } from "@/lib/mail/receipt-store";
import { captureReceiptSnapshot, receiptSnapshotRows, validateReceiptSnapshot, RECEIPT_SNAPSHOT_PREFIX, LEGACY_RECEIPT_SNAPSHOT_PREFIX } from "@/lib/mail/receipt-snapshot";
import { analyzeReceipts } from "@/lib/mail/receipt-analysis";
import { buildRecentReceiptRows } from "@/lib/profile/gmail-receipt-presentation";
import { MailReceiptResourceService as Resource } from "@/lib/services/mail-receipt-resource-service";
import { GmailReceiptsService, type GmailLiveReceiptScanResponse } from "@/lib/services/gmail-receipts-service";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { mergeReceiptSnapshot } from "@/lib/mail/receipt-continuity";
import { clearCachedGmailReceipts } from "@/lib/profile/gmail-receipts-cache";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

const key = "12".repeat(32);
const request = { from_date: "2026-09-01", to_date: "2026-11-01", timezone: "Asia/Kolkata", group_by: "merchant", limit: 25 };
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

describe("canonical receipt storage boundary", () => {
  it("saves the live extraction's verbatim printed dates and restores the same canonical rows", async () => {
    const items = [receipt(1, { merchant_name: "Plaid", merchant_domain: "plaid.com", transaction_date: "October 9, 2026",
      attention_state: "coming_up", attention_reason: "renewal_due", attention_date: "October 18" })];
    const original = buildRecentReceiptRows(items, "account");
    const snapshot = await captureReceiptSnapshot(items, "account", coverage);
    const session = { userId: "owner", vaultKey: key, vaultOwnerToken: "owner-token" };
    await writeReceiptSnapshot(session, snapshot, await receiptStoreVersion("owner", "account"));
    const loaded = await loadReceiptSnapshot(session, "account");
    expect(loaded?.revision).toBe(1);
    const restored = receiptSnapshotRows(loaded!.value);
    expect(restored.map(r => [r.id, r.merchantName, r.amount, r.status, r.receiptDate, r.attentionDate, r.secondaryText]))
      .toEqual(original.map(r => [r.id, r.merchantName, r.amount, r.status, r.receiptDate, r.attentionDate, r.secondaryText]));
    for (const date of ["https://example.com", "user@example.com", "October 18\nRAW_BODY"])
      expect(() => validateReceiptSnapshot({ ...snapshot, rows: [{ ...snapshot.rows[0], attention_date: date }] })).toThrow();
  });
  it("keeps the previous verified snapshot on encryption, quota or transaction failure", async () => {
    const session = { userId: "owner", vaultKey: key, vaultOwnerToken: "owner-token" };
    const previous = await captureReceiptSnapshot([receipt(1)], "account", coverage);
    await writeReceiptSnapshot(session, previous, { generation: 0, revision: 0 });
    const replacement = await captureReceiptSnapshot([receipt(2, { amount: 99, amount_decimal: "99.00" })], "account", coverage);
    const originalPut = FakeObjectStore.prototype.put;
    const attempts = [
      () => vi.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(new DOMException("synthetic", "OperationError")),
      () => vi.spyOn(FakeObjectStore.prototype, "put").mockImplementationOnce(() => { throw new DOMException("synthetic", "QuotaExceededError"); }),
      () => vi.spyOn(FakeObjectStore.prototype, "put").mockImplementationOnce(function (this: IDBObjectStore, ...args) {
        const request = originalPut.apply(this, args); this.transaction.abort(); return request;
      }),
    ];
    const codes = ["encryption_failed", "quota_exceeded", "transaction_failed"];
    for (let i = 0; i < attempts.length; i++) {
      const fault = attempts[i]();
      await expect(writeReceiptSnapshot(session, replacement, { generation: 0, revision: 1 })).rejects.toMatchObject({ code: codes[i] });
      fault.mockRestore();
      const loaded = await loadReceiptSnapshot(session, "account");
      expect(loaded).toMatchObject({ revision: 1, value: previous });
      expect(await Durable.list("owner", RECEIPT_SNAPSHOT_PREFIX)).toHaveLength(1);
    }
  });
  it("failed encrypted read-back never replaces the previous valid snapshot", async () => {
    const session = { userId: "owner", vaultKey: key, vaultOwnerToken: "owner-token" };
    const previous = await captureReceiptSnapshot([receipt(1)], "account", coverage);
    await writeReceiptSnapshot(session, previous, { generation: 0, revision: 0 });
    const replacement = await captureReceiptSnapshot([receipt(2, { amount: 99, amount_decimal: "99.00" })], "account", coverage);
    const fault = vi.spyOn(crypto.subtle, "decrypt").mockRejectedValueOnce(new DOMException("synthetic", "OperationError"));
    const failure = await writeReceiptSnapshot(session, replacement, { generation: 0, revision: 1 }).catch(error => error);
    fault.mockRestore();
    const recovered = await loadReceiptSnapshot(session, "account");
    expect(recovered).toMatchObject({ revision: 1, value: previous });
    expect(failure).toMatchObject({ code: "readback_failed", stage: "readback" });
  });
  it("fences Reset while the candidate is being decrypted, without recreating old receipts", async () => {
    const session = { userId: "owner", vaultKey: key, vaultOwnerToken: "owner-token" };
    const snapshot = await captureReceiptSnapshot([receipt(1)], "account", coverage);
    await writeReceiptSnapshot(session, snapshot, { generation: 0, revision: 0 });
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
      const value = await originalDecrypt(...args);
      await Durable.purgeUser("owner");
      return value;
    });
    await expect(writeReceiptSnapshot(session, snapshot, { generation: 0, revision: 1 })).rejects.toMatchObject({ code: "stale_version" });
    expect(await loadReceiptSnapshot(session, "account")).toBeNull();
    expect(await Durable.list("owner", RECEIPT_SNAPSHOT_PREFIX)).toEqual([]);
  });
  it("retains the shortest sealed locator and rejects truncated locator payloads", async () => {
    const locator = "grs1_" + "a".repeat(39);
    const snapshot = await captureReceiptSnapshot([receipt(1, { durable_source_ref: locator })], "account", coverage);
    expect(validateReceiptSnapshot(snapshot).rows[0].events[0].locator).toBe(locator);
    const truncated = structuredClone(snapshot);
    truncated.rows[0].events[0].locator = locator.slice(0, -1);
    expect(() => validateReceiptSnapshot(truncated)).toThrow("Invalid receipt event.");
  });
  it("roundtrips every reviewed merchant using only stable brand keys without URLs", async () => {
    const brands = [
      ["Myntra", "myntra.com", "myntra"], ["Amazon", "amazon.in", "amazon"],
      ["Apple", "apple.com", "apple"], ["PayPal", "paypal.com", "paypal"],
      ["Plaid", "plaid.com", "plaid"], ["Supabase", "supabase.com", "supabase"],
      ["Kyari", "kyari.co", "kyari"], ["Anthropic", "anthropic.com", "anthropic"],
      ["Google Play", "google.com", "google-play"], ["IndiGo", "goindigo.in", "indigo"],
      ["Internshala Trainings", "internshala.com", "internshala-trainings"], ["Udemy", "email.udemy.com", "udemy"],
    ] as const;
    const items = brands.map(([merchant_name, merchant_domain], index) => receipt(index + 1, { merchant_name, merchant_domain }));
    const snapshot = await captureReceiptSnapshot(items, "account", coverage);
    expect(snapshot.rows.map(row => row.brand)).toEqual(brands.map(([, , key]) => key));
    const restored = receiptSnapshotRows(snapshot);
    expect(restored.map(row => row.brandKey)).toEqual(brands.map(([, , key]) => key));
    expect(restored.map(row => row.logoDomain)).toEqual(buildRecentReceiptRows(items, "account").map(row => row.logoDomain));
    const serialized = JSON.stringify(snapshot);
    for (const raw of ["https:", "homepageUrl", "logoDomain", "logoUrl", "plaid.com", "supabase.com", "kyari.co", "anthropic.com", "play.google.com", "goindigo.in"]) expect(serialized).not.toContain(raw);
    expect(() => validateReceiptSnapshot({ ...snapshot, rows: [{ ...snapshot.rows[0], brand: "unreviewed" }] })).toThrow();
    expect(() => validateReceiptSnapshot({ ...snapshot, rows: [{ ...snapshot.rows[0], homepageUrl: "https://plaid.com" }] })).toThrow();
  });
  it("reconciles legacy platform keys to the reviewed seller while keeping null and unknown brands closed", async () => {
    const snapshot = await captureReceiptSnapshot([
      receipt(1, { merchant_name: "Kyari.co", merchant_domain: "kyari.co" }),
      receipt(2, { merchant_name: "Plaid", merchant_domain: "plaid.com" }),
      receipt(3, { merchant_name: "Local Shop", merchant_domain: "amazon.com" }),
    ], "account", coverage);
    snapshot.rows[0].brand = "amazon"; // Existing sender-only branding selected the carrier.
    snapshot.rows[1].brand = null; // No retained domain evidence can distinguish an old gap from a rejection.
    snapshot.rows[2].brand = "amazon";
    const before = JSON.stringify(snapshot);
    const restored = receiptSnapshotRows(snapshot);
    expect(restored.map(row => [row.merchantName, row.brandKey, row.logoDomain])).toEqual([
      ["Kyari.co", "kyari", "kyari.co"], ["Plaid", null, null], ["Local Shop", null, null],
    ]);
    expect(restored.map(row => row.id)).toEqual(snapshot.rows.map(row => row.display_id));
    expect(restored.map(row => row.primaryReceiptKey)).toEqual(snapshot.rows.map(row => row.primary_event_ref));
    expect(JSON.stringify(snapshot)).toBe(before);
  });
  it("roundtrips grouped UI projections without any raw email fields or provider identities", async () => {
    const items = [receipt(1), receipt(2, { identifiers: [{ kind: "order", value: "ORDER-1" }], event_type: "fulfillment", status: "delivered", document_kind: "fulfillment" }), receipt(3)];
    const snapshot = await captureReceiptSnapshot(items, "raw@example.com", coverage);
    const original = buildRecentReceiptRows(items, "raw@example.com");
    const version = await Durable.version("owner", "mail:test");
    await Durable.write({ userId: "owner", resourceKey: "mail:test", vaultKey: key, value: snapshot, expected: version, isCurrent: () => true });
    // A fresh read uses only IndexedDB and the owner's newly supplied key.
    const stored = await Durable.read<typeof snapshot>("owner", "mail:test", key);
    const restored = receiptSnapshotRows(stored!.value);
    expect(restored.map(r => [r.merchantName, r.amount, r.currency, r.status, r.category, r.secondaryText, r.sourceReceiptKeys.length])).toEqual(original.map(r => [r.merchantName, r.amount, r.currency, r.status, r.category, r.secondaryText, r.sourceReceiptKeys.length]));
    const json = JSON.stringify(stored);
    for (const raw of ["RAW_", "raw@example.com", "gmail_live_", "source_evidence", "short_detail", "subject", "gmail_message_id"]) expect(json).not.toContain(raw);
    expect(() => validateReceiptSnapshot({ ...snapshot, body: "negative control" })).toThrow();
    expect(() => validateReceiptSnapshot({ ...snapshot, rows: [{ ...snapshot.rows[0], subject: "negative control" }] })).toThrow();
    await expect(Durable.read("other", "mail:test", key)).resolves.toBeNull();
    await expect(Durable.read("owner", "mail:test", "34".repeat(32))).rejects.toThrow();
  });
  it("atomically rejects concurrent/stale writes and Reset removes ciphertext and fences old work", async () => {
    const v = await Durable.version("owner", "mail:test");
    await Durable.write({ userId: "owner", resourceKey: "mail:test", vaultKey: key, value: { safe: 1 }, expected: v, isCurrent: () => true });
    await expect(Durable.write({ userId: "owner", resourceKey: "mail:test", vaultKey: key, value: {}, expected: v, isCurrent: () => true })).rejects.toThrow(/changed/);
    const preReset = await Durable.version("owner", "mail:test");
    await Durable.purgeUser("owner");
    expect(await Durable.read("owner", "mail:test", key)).toBeNull();
    await expect(Durable.write({ userId: "owner", resourceKey: "mail:test", vaultKey: key, value: {}, expected: preReset, isCurrent: () => true })).rejects.toThrow(/reset/);
  });
  it("authenticates encrypted snapshot revision metadata as AAD", async () => {
    await Durable.write({ userId: "owner", resourceKey: "mail:test", vaultKey: key, value: { safe: 1 }, expected: { generation: 0, revision: 0 }, isCurrent: () => true });
    const db = (await openSecureResourceDb())!;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DURABLE_RESOURCE_STORE, "readwrite"), store = tx.objectStore(DURABLE_RESOURCE_STORE);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      const request = store.get(JSON.stringify(["owner", "mail:test"]));
      request.onsuccess = () => store.put({ ...request.result, revision: 2 });
    }); db.close();
    await expect(Durable.read("owner", "mail:test", key)).rejects.toThrow();
  });
  it("checks owner authority again after final asynchronous snapshot reads", async () => {
    const snapshot = await captureReceiptSnapshot([receipt(1)], "account", coverage);
    const session = { userId: "owner", vaultKey: key, vaultOwnerToken: "owner-token" };
    await writeReceiptSnapshot(session, snapshot, { generation: 0, revision: 0 });
    const original = Durable.version.bind(Durable); let calls = 0;
    vi.spyOn(Durable, "version").mockImplementation(async (...args) => { const version = await original(...args); if (++calls === 2) publishValidatedAuthSessionOwner("other"); return version; });
    await expect(runReceiptFunction(session, "receipt_spending", request, "account")).rejects.toThrow(/authority changed/);
    vi.restoreAllMocks(); publishValidatedAuthSessionOwner("owner");
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => { const value = await originalDecrypt(...args); publishValidatedAuthSessionOwner("other"); return value; });
    await expect(writeReceiptSnapshot(session, snapshot, { generation: 0, revision: 1 })).rejects.toThrow(/authority changed/);
  });
  it("uses canonical dedupe and decimal totals with distinct currencies and honest refunds", async () => {
    const snapshot = await captureReceiptSnapshot([receipt(1), receipt(2, { amount: 0.2, amount_decimal: "0.20" }),
      receipt(3, { identifiers: [{ kind: "order", value: "ORDER-1" }] }),
      receipt(4, { amount: 10, amount_decimal: "10.00", currency: "INR" }),
      receipt(5, { status: "refunded", event_type: "refund", amount: 100, amount_decimal: "100.00" }),
      receipt(6, { status: "cancelled", event_type: "cancellation" }), receipt(7, { status: "trial" }),
      receipt(8, { status: "payment_failed" }), receipt(9, { status: "delivered", event_type: "fulfillment" }), receipt(10, { currency: "$" }),
    ], "account", coverage);
    const result = analyzeReceipts("receipt_spending", request, snapshot, 1);
    expect(result.canonical_transaction_count).toBe(9);
    expect(result.included_count).toBe(3);
    expect(result.results).toEqual([
      expect.objectContaining({ currency: "INR", paid_amount: "10.00", paid_transaction_count: 1, net_amount: null }),
      expect.objectContaining({ currency: "USD", paid_amount: "0.30", paid_transaction_count: 2, net_amount: null }),
    ]);
    expect(result.refund_handling).toMatchObject({ record_count: 1, amount: null, net: null });
    expect(result.currency_totals).toEqual([
      { currency: "INR", paid_amount: "10.00", paid_transaction_count: 1, refund_amount: null, net_amount: null },
      { currency: "USD", paid_amount: "0.30", paid_transaction_count: 2, refund_amount: null, net_amount: null },
    ]);
    const product = analyzeReceipts("receipt_spending", { ...request, group_by: "product" }, snapshot, 1);
    expect(product).toMatchObject({ status: "unsupported", unsupported: "product_data_unavailable", results: [] });
    expect(analyzeReceipts("most_frequently_purchased_products", { from_date: request.from_date, to_date: request.to_date, timezone: request.timezone }, snapshot, 1)).toMatchObject({ unsupported: "product_data_unavailable" });
  });
  it("returns exact currency totals over all included groups when the ranking is bounded", async () => {
    const snapshot = await captureReceiptSnapshot([receipt(1), receipt(2, { merchant_name: "Apple", merchant_domain: "apple.com", sender_domain: "apple.com", amount: 0.2, amount_decimal: "0.20" })], "account", coverage);
    const result = analyzeReceipts("receipt_spending", { ...request, limit: 1 }, snapshot, 1);
    expect(result).toMatchObject({ truncated: true, included_count: 2, currency_totals: [{ currency: "USD", paid_amount: "0.30", paid_transaction_count: 2, net_amount: "0.30" }] });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ label: "Apple", paid_amount: "0.20" });
  });
  it("keeps a calendar transaction date in the owner's timezone and rejects malformed decimal evidence", async () => {
    const snapshot = await captureReceiptSnapshot([receipt(1, { transaction_date: "2026-10-01" })], "account", coverage);
    expect(analyzeReceipts("list_recent_receipts", { from_date: "2026-10-01", to_date: "2026-10-02", timezone: "America/Los_Angeles" }, snapshot, 1).matched_count).toBe(1);
    expect(() => validateReceiptSnapshot({ ...snapshot, rows: [{ ...snapshot.rows[0], amount: 1 }] })).toThrow();
    expect(() => validateReceiptSnapshot({ ...snapshot, rows: [{ ...snapshot.rows[0], confidence: Number.NaN }] })).toThrow();
  });
  it("dates printed receipts by their ISO email day in the owner's zone and counts unreadable dates as undated", async () => {
    // Emailed 01:30 on October 10 in Kolkata. Printed text is never parsed, so a year-less or unparseable date can't throw.
    const snapshot = await captureReceiptSnapshot([receipt(1, { transaction_date: "October 9, 2026", gmail_internal_date: "2026-10-09T20:00:00Z" }),
      receipt(2, { transaction_date: "9 Oct 2026 10:23 IST" }), receipt(3, { transaction_date: "Oct 9" })], "account", coverage);
    const result = analyzeReceipts("list_recent_receipts", { from_date: "2026-10-01", to_date: "2026-11-01", timezone: "Asia/Kolkata" }, snapshot, 1);
    expect(result).toMatchObject({ matched_count: 1, coverage: { undated_count: 2 }, results: [{ transaction_date: "2026-10-10" }] });
    // Negative control: the hub admits only ISO dates, and every stored printed value (once emitted verbatim) fails it.
    const hubDate = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))?$/;
    expect(snapshot.rows.filter(row => hubDate.test(row.transaction_date ?? ""))).toEqual([]);
  });
  it("states coverage gaps and staleness, and lists only the attention state One asked for", async () => {
    const snapshot = await captureReceiptSnapshot([receipt(1, { status: "overdue", attention_state: "needs_attention", attention_reason: "overdue" }),
      receipt(2, { status: "renewal_due", attention_state: "coming_up", attention_reason: "renewal_due" }), receipt(3)],
    "account", { ...coverage, partial: true, window_from: "2026-09-15T00:00:00+00:00" }, new Date("2026-10-10T00:00:00Z"));
    const list = (extra: object) => analyzeReceipts("list_recent_receipts", { from_date: "2026-09-01", to_date: "2026-11-01", timezone: "UTC", ...extra }, snapshot, 1, Date.parse("2026-10-20T00:00:00Z"));
    expect(list({ attention: "needs_attention" }).results).toEqual([expect.objectContaining({ status: "overdue" })]);
    expect(list({ attention: "coming_up" }).results).toEqual([expect.objectContaining({ status: "renewal_due" })]);
    expect(list({}).limitations.slice(4)).toEqual(["Receipts only go back to 2026-09-15; earlier purchases are not included.",
      "Receipt sync is incomplete, so some receipts may be missing.", "Receipts were last updated on 2026-10-10."]);
    expect(list({ from_date: "2026-09-15" }).limitations).toHaveLength(6);
    for (const extra of [{ attention: "overdue" }, { attention: null }]) expect(() => list(extra)).toThrow();
    expect(() => analyzeReceipts("receipt_spending", { ...request, attention: "coming_up" }, snapshot, 1)).toThrow();
  });
});

const session = { userId: "owner", vaultKey: key, vaultOwnerToken: "owner-token" };
const checkpoint = (letter: string) => "grc1_" + letter.repeat(64);
const stableReceipt = (id: number, extra: Partial<ReceiptListItem> = {}) => receipt(id, { event_id: id.toString(16).repeat(64), ...extra });
function scanPage(items: ReceiptListItem[], extra: Partial<GmailLiveReceiptScanResponse> = {}): GmailLiveReceiptScanResponse {
  return { items: items as GmailLiveReceiptScanResponse["items"], page: 1, per_page: 6, returned_count: items.length,
    sync_mode: "bootstrap", checkpoint: checkpoint("a"), has_more: false,
    coverage: { source: "gmail_live", listed_count: items.length, candidate_count: items.length, matched_count: items.length,
      pages_scanned: 1, max_messages: 6, max_pages: 50, reached_limit: false, query_scope: "receipt_signals_all_mail_except_spam_trash",
      rejection_counts: { missing_receipt_signal: 0, extractor_not_receipt: 0 },
      evidence_counts: { gmail_category: 0, subject_signal: 0, body_signal: 0, verified_merchant: 0, order_candidate: 0, total_candidate: 0 } }, ...extra };
}
describe("Mail saved-first return and incremental continuity", () => {
  it("restores the 22nd without a provider read, catches up on the 24th and preserves archived source deletion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
    const scan = vi.spyOn(GmailReceiptsService, "scanReceipts").mockResolvedValueOnce(scanPage([stableReceipt(1), stableReceipt(2)]));
    await Resource.refresh(session, "account", async () => "synthetic");
    Resource.clear("owner");
    await Resource.hydrate(session, "account");
    expect(scan).toHaveBeenCalledTimes(1);
    expect(Resource.peek("owner", "account").snapshot?.rows).toHaveLength(2);
    vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
    expect(Resource.isStale("owner", "account")).toBe(true);
    scan.mockResolvedValueOnce(scanPage([stableReceipt(2, { status: "delivered" }), stableReceipt(3)],
      { sync_mode: "delta", checkpoint: checkpoint("b"), unavailable_events: ["1".repeat(64)] }));
    const result = await Resource.refresh(session, "account", async () => "synthetic");
    expect(scan.mock.calls[1]?.[0].checkpoint).toBe(checkpoint("a"));
    expect(result.snapshot.rows).toHaveLength(3);
    expect(result.snapshot.sync?.checkpoint).toBe(checkpoint("b"));
    expect(receiptSnapshotRows(result.snapshot).find(row => row.sourceReceiptKeys.includes("1".repeat(64)))?.sourceUnavailable).toBe(true);
    scan.mockResolvedValueOnce(scanPage([stableReceipt(2), stableReceipt(3)], { sync_mode: "delta", checkpoint: checkpoint("c") }));
    await Resource.refresh(session, "account", async () => "synthetic");
    expect(Resource.peek("owner", "account").snapshot?.rows).toHaveLength(3);
    Resource.clear("owner");
    expect((await Resource.hydrate(session, "account"))?.rows).toHaveLength(3);
  });
  it("shares consumers and coalesces a force burst into one trailing request", async () => {
    let finish!: (value: GmailLiveReceiptScanResponse) => void;
    const scan = vi.spyOn(GmailReceiptsService, "scanReceipts").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(scanPage([], { sync_mode: "delta", checkpoint: checkpoint("b") }));
    const first = Resource.refresh(session, "account", async () => "synthetic");
    const joined = Array.from({ length: 10 }, () => Resource.refresh(session, "account", async () => "synthetic", { force: true }));
    expect(joined.every(promise => promise === first)).toBe(true);
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    finish(scanPage([stableReceipt(1)]));
    await Promise.all([first, ...joined]);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(Resource.peek("owner", "account").refreshing).toBe(false);
  });
  it("preserves rows and checkpoint on truncated passes and rejected device commits", async () => {
    const scan = vi.spyOn(GmailReceiptsService, "scanReceipts").mockResolvedValueOnce(scanPage([stableReceipt(1), stableReceipt(2)]));
    await Resource.refresh(session, "account", async () => "synthetic");
    const limited = scanPage([stableReceipt(3)], { checkpoint: null }); limited.coverage.reached_limit = true;
    scan.mockResolvedValueOnce(limited);
    const partial = await Resource.refresh(session, "account", async () => "synthetic");
    expect(partial.snapshot.rows).toHaveLength(3);
    expect(partial.snapshot.sync?.checkpoint).toBe(checkpoint("a"));
    scan.mockResolvedValueOnce(scanPage([stableReceipt(4)], { sync_mode: "delta", checkpoint: checkpoint("d") }));
    vi.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(new Error("synthetic quota"));
    await expect(Resource.refresh(session, "account", async () => "synthetic")).rejects.toThrow();
    expect((await loadReceiptSnapshot(session, "account"))?.value).toEqual(partial.snapshot);
  });
  it("times out a hung token or scan and fences its late completion", async () => {
    vi.spyOn(GmailReceiptsService, "scanReceipts").mockResolvedValueOnce(scanPage([stableReceipt(1)]));
    const initial = await Resource.refresh(session, "account", async () => "synthetic");
    let release!: (token: string) => void;
    const token = new Promise<string>(resolve => { release = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = Resource.refresh(session, "account", () => token);
    const assertion = expect(pending).rejects.toThrow("paused");
    await vi.advanceTimersByTimeAsync(120_001);
    await assertion;
    expect(Resource.peek("owner", "account").refreshing).toBe(false);
    release("late-synthetic"); await Promise.resolve(); vi.useRealTimers();
    expect((await loadReceiptSnapshot(session, "account"))?.value).toEqual(initial.snapshot);
    clearCachedGmailReceipts("owner");
    expect(Resource.peek("owner", "account").snapshot).toBeNull();
    expect((await loadReceiptSnapshot(session, "account"))?.value).toEqual(initial.snapshot);
  });
  it("retains a verified empty snapshot and rejects private fields in continuity", async () => {
    vi.spyOn(GmailReceiptsService, "scanReceipts").mockResolvedValueOnce(scanPage([]));
    const result = await Resource.refresh(session, "account", async () => "synthetic");
    Resource.clear("owner");
    expect((await Resource.hydrate(session, "account"))?.rows).toEqual([]);
    expect(Resource.peek("owner", "account").hydrated).toBe(true);
    expect(() => validateReceiptSnapshot({ ...result.snapshot, sync: { ...result.snapshot.sync, raw_email: "private" } })).toThrow();
  });
});


describe("incremental event grouping and durable continuation", () => {
  it("groups a new delivery with its saved purchase and retains combined facts on a primary-only update", async () => {
    const scan = vi.spyOn(GmailReceiptsService, "scanReceipts").mockResolvedValueOnce(scanPage([stableReceipt(1)]));
    const initial = await Resource.refresh(session, "account", async () => "synthetic");
    scan.mockResolvedValueOnce(scanPage([stableReceipt(2, { identifiers: [{ kind: "order", value: "ORDER-1" }], document_kind: "fulfillment",
      event_type: "fulfillment", status: "delivered", transaction_date: "2026-10-02T12:00:00Z" })], { sync_mode: "delta", checkpoint: checkpoint("b") }));
    const updated = await Resource.refresh(session, "account", async () => "synthetic");
    expect(updated.snapshot.rows).toHaveLength(1);
    expect(updated.snapshot.rows[0]).toMatchObject({ display_id: initial.snapshot.rows[0]!.display_id, status: "delivered" });
    expect(updated.snapshot.rows[0]?.events).toHaveLength(2);
    scan.mockResolvedValueOnce(scanPage([stableReceipt(1)], { sync_mode: "delta", checkpoint: checkpoint("c") }));
    expect((await Resource.refresh(session, "account", async () => "synthetic")).snapshot.rows[0]?.status).toBe("delivered");
  });
  it("restores a verified partial page and resumes its cursor after a failed second page", async () => {
    const first = scanPage([stableReceipt(1)], { has_more: true, next_cursor: "synthetic-signed-cursor", checkpoint: null });
    const scan = vi.spyOn(GmailReceiptsService, "scanReceipts").mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("synthetic dependency"));
    await expect(Resource.refresh(session, "account", async () => "synthetic")).rejects.toThrow();
    const partial = await loadReceiptSnapshot(session, "account");
    expect(partial?.value.rows).toHaveLength(1);
    expect(partial?.value.sync).toMatchObject({ checkpoint: null, pending: { page: 1, cursor: "synthetic-signed-cursor" } });
    Resource.clear("owner");
    const second = scanPage([stableReceipt(2)], { page: 2, checkpoint: checkpoint("b") });
    scan.mockResolvedValueOnce(second);
    const result = await Resource.refresh(session, "account", async () => "synthetic");
    expect(scan.mock.calls.at(-1)?.[0]).toMatchObject({ page: 2, cursor: "synthetic-signed-cursor", accountKey: "account" });
    expect(result.snapshot.rows).toHaveLength(2);
    expect(result.snapshot.sync).toMatchObject({ checkpoint: checkpoint("b"), pending: null });
    expect(result.snapshot.coverage.partial).toBe(false);
  });
});


describe("receipt continuity failure boundaries", () => {
  it("isolates an upgraded ledger from a successful legacy-tab write and fences both formats on Reset", async () => {
    const legacy = await captureReceiptSnapshot([stableReceipt(1)], "account", coverage);
    const legacyKey = LEGACY_RECEIPT_SNAPSHOT_PREFIX + legacy.account_binding;
    const oldWrite = (value: typeof legacy, expected: { generation: number; revision: number }) => Durable.write({ ...session,
      resourceKey: legacyKey, value, expected, isCurrent: () => true });
    await oldWrite(legacy, { generation: 0, revision: 0 });
    await oldWrite(legacy, { generation: 0, revision: 1 });
    expect((await runReceiptFunction(session, "receipt_spending", request, "account")).snapshot_revision).toBe(2);
    expect(await loadReceiptSnapshot(session, "account")).toMatchObject({ value: legacy, revision: 0 });
    const scan = vi.spyOn(GmailReceiptsService, "scanReceipts").mockResolvedValueOnce(scanPage([stableReceipt(1), stableReceipt(2)]));
    const upgraded = await Resource.refresh(session, "account", async () => "synthetic");
    expect(upgraded.snapshot.rows).toHaveLength(2);
    expect((await Durable.read<typeof legacy>("owner", legacyKey, key))?.value).toEqual(legacy);
    // The old bundle accepts V1 only, and its bootstrap can successfully save
    // after a newer bundle has accumulated additional receipts.
    const oldRevision = await Durable.version("owner", legacyKey);
    await oldWrite({ ...legacy, freshness: "2026-10-25T12:00:00Z" }, oldRevision);
    Resource.clear("owner");
    expect(await Resource.hydrate(session, "account")).toEqual(upgraded.snapshot);
    expect((await loadReceiptSnapshot(session, null))?.value).toEqual(upgraded.snapshot);
    expect(scan).toHaveBeenCalledOnce();
    const nextLegacy = await Durable.version("owner", legacyKey);
    await Durable.purgeUser("owner");
    expect(await Durable.list("owner", "mail_receipts.")).toEqual([]);
    await expect(oldWrite(legacy, nextLegacy)).rejects.toMatchObject({ code: "stale_version" });
    await expect(writeReceiptSnapshot(session, upgraded.snapshot, upgraded)).rejects.toMatchObject({ code: "stale_version" });
    expect(await loadReceiptSnapshot(session, "account")).toBeNull();
  });
  it("rejects a legacy migration raced by a newer ledger commit", async () => {
    const legacy = await captureReceiptSnapshot([stableReceipt(1)], "account", coverage);
    const legacyKey = LEGACY_RECEIPT_SNAPSHOT_PREFIX + legacy.account_binding;
    await Durable.write({ ...session, resourceKey: legacyKey, value: legacy, expected: { generation: 0, revision: 0 }, isCurrent: () => true });
    const upgraded = await mergeReceiptSnapshot(legacy, [stableReceipt(2)], "account", scanPage([]), [], true);
    const read = Durable.read.bind(Durable);
    vi.spyOn(Durable, "read").mockImplementationOnce(read).mockImplementationOnce(async (...args) => {
      await writeReceiptSnapshot(session, upgraded, { generation: 0, revision: 0 });
      return read(...args);
    });
    const stale = await loadReceiptSnapshot(session, "account");
    expect(stale).toMatchObject({ value: legacy, revision: 0 });
    await expect(writeReceiptSnapshot(session, legacy, stale!)).rejects.toMatchObject({ code: "stale_version" });
    expect((await loadReceiptSnapshot(session, "account"))?.value).toEqual(upgraded);
  });

  it("cannot overwrite a ledger committed while both fallback reads were absent", async () => {
    await Resource.hydrate(session, "account");
    const upgraded = await mergeReceiptSnapshot(null, [stableReceipt(2)], "account", scanPage([]), [], true);
    const read = Durable.read.bind(Durable); let raced = false;
    vi.spyOn(Durable, "read").mockImplementation(async (...args) => {
      if (args[1].startsWith(LEGACY_RECEIPT_SNAPSHOT_PREFIX) && !raced) {
        raced = true; await writeReceiptSnapshot(session, upgraded, { generation: 0, revision: 0 });
      }
      return read(...args);
    });
    vi.spyOn(GmailReceiptsService, "scanReceipts").mockResolvedValueOnce(scanPage([stableReceipt(1)]));
    await expect(Resource.refresh(session, "account", async () => "synthetic")).rejects.toMatchObject({ code: "stale_version" });
    expect((await loadReceiptSnapshot(session, "account"))?.value).toEqual(upgraded);
  });
  it("aborts a promotion transaction when its operation is cancelled", async () => {
    const initial = await captureReceiptSnapshot([receipt(1)], "account", coverage);
    await writeReceiptSnapshot(session, initial, { generation: 0, revision: 0 });
    const next = await captureReceiptSnapshot([receipt(2)], "account", coverage);
    const controller = new AbortController();
    const originalPut = FakeObjectStore.prototype.put;
    const fault = vi.spyOn(FakeObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = originalPut.apply(this, args);
      if (this.name === DURABLE_RESOURCE_STORE && !String((args[0] as { key: string }).key).includes('"pending"')) controller.abort();
      return request;
    });
    await expect(writeReceiptSnapshot({ ...session, signal: controller.signal }, next, { generation: 0, revision: 1 })).rejects.toThrow();
    fault.mockRestore();
    expect(await loadReceiptSnapshot(session, "account")).toMatchObject({ revision: 1, value: initial });
  });
  it("starts renewed authority without joining an obsolete pending scan", async () => {
    let finish!: (value: GmailLiveReceiptScanResponse) => void;
    const scan = vi.spyOn(GmailReceiptsService, "scanReceipts").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(scanPage([stableReceipt(2)]));
    const old = Resource.refresh(session, "account", async () => "old-token");
    const rejected = expect(old).rejects.toThrow();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
    advanceVaultSessionEpoch();
    const next = await Resource.refresh(session, "account", async () => "new-token");
    finish(scanPage([stableReceipt(1)])); await rejected;
    expect(scan.mock.calls[1]?.[0].idToken).toBe("new-token");
    expect(Resource.peek("owner", "account").snapshot).toEqual(next.snapshot);
    expect(next.snapshot.rows).toHaveLength(1);
  });
  it("resumes after a bounded fifty-page batch without advancing the completed checkpoint", async () => {
    const scan = vi.spyOn(GmailReceiptsService, "scanReceipts").mockImplementation(async ({ page = 1 }) => {
      const result = scanPage([], { page, has_more: true, next_cursor: `synthetic-page-${page % 50 + 1}`, checkpoint: null });
      result.coverage.reached_limit = page === 50; return result;
    });
    const partial = await Resource.refresh(session, "account", async () => "synthetic");
    expect(scan).toHaveBeenCalledTimes(50);
    expect(partial.complete).toBe(false);
    expect(partial.snapshot.sync).toMatchObject({ checkpoint: null, pending: { page: 50, cursor: "synthetic-page-1" } });
    Resource.clear("owner"); scan.mockResolvedValueOnce(scanPage([stableReceipt(2)], { checkpoint: checkpoint("b") }));
    const complete = await Resource.refresh(session, "account", async () => "synthetic");
    expect(scan.mock.calls.at(-1)?.[0]).toMatchObject({ page: 1, cursor: "synthetic-page-1" });
    expect(complete.complete).toBe(true); expect(complete.snapshot.sync?.pending).toBeNull();
  });
  it("counts partially converted legacy groups once and rejects conflicting ledger identities", async () => {
    const a = receipt(1), b = receipt(2, { identifiers: a.identifiers, event_type: "fulfillment", status: "delivered", document_kind: "fulfillment" });
    const legacy = await captureReceiptSnapshot([a, b], "account", { ...coverage, source_count: 2 });
    const updated = await mergeReceiptSnapshot(legacy, [{ ...a, event_id: "a".repeat(64) }], "account", scanPage([]), [], true);
    expect(updated.coverage.source_count).toBe(2);
    expect(updated.sync?.archive_refs).toHaveLength(1);
    expect(() => validateReceiptSnapshot({ ...updated, sync: { ...updated.sync, records: [...updated.sync!.records, updated.sync!.records[0]] } })).toThrow();
    expect(() => validateReceiptSnapshot({ ...updated, sync: { ...updated.sync, archive_refs: ["f".repeat(64)] } })).toThrow();
    expect(() => validateReceiptSnapshot({ ...updated, sync: { ...updated.sync, records: [] } })).toThrow();
  });
});
