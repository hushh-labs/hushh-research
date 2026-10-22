import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { SecureDurableResourceService as Durable } from "@/lib/services/secure-durable-resource-service";
import { openSecureResourceDb, DURABLE_RESOURCE_STORE } from "@/lib/services/secure-resource-cache-service";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { loadReceiptSnapshot, receiptStoreVersion, runReceiptFunction, writeReceiptSnapshot } from "@/lib/mail/receipt-store";
import { captureReceiptSnapshot, receiptSnapshotRows, validateReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import { analyzeReceipts } from "@/lib/mail/receipt-analysis";
import { buildRecentReceiptRows } from "@/lib/profile/gmail-receipt-presentation";
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
beforeEach(() => { vi.restoreAllMocks(); publishValidatedAuthSessionOwner("owner"); Object.defineProperty(window, "indexedDB", { value: new IDBFactory(), configurable: true }); Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }); });

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
      expect(await Durable.list("owner", "mail_receipts.v1:")).toHaveLength(1);
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
    expect(await Durable.list("owner", "mail_receipts.v1:")).toEqual([]);
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
});
