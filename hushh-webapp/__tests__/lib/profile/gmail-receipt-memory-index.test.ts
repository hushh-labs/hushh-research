import { describe, expect, it } from "vitest";

import {
  buildReceiptCanonicalIndex,
  mergeReceiptsMemoryWithIndex,
  parseReceiptCanonicalIndex,
  readReceiptCanonicalIndex,
  receiptIndexDigest,
  RECEIPT_INDEX_BRANCH,
  RECEIPT_INDEX_MAX_TRANSACTIONS,
} from "@/lib/profile/gmail-receipt-memory-index";
import { buildRecentReceiptRows } from "@/lib/profile/gmail-receipt-presentation";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

const NOW = new Date("2026-10-09T10:00:00.000Z");

/** A scanned receipt carrying every raw field a mailbox would, so leaks are visible. */
function receipt(id: number, overrides: Partial<ReceiptListItem> = {}): ReceiptListItem {
  return {
    id,
    source_id: `gmail_live_secretsource${id}.0123456789abcdef`,
    receipt_key: `gmail_live_secretsource${id}.0123456789abcdef`,
    source_kind: "gmail_live",
    gmail_message_id: `rawmessage${id}`,
    gmail_thread_id: `rawthread${id}`,
    from_email: "billing@supabase.io",
    from_name: "Supabase Billing",
    subject: `Invoice ${id} from Supabase https://track.example/${id}`,
    snippet: `Snippet body text ${id}`,
    preview: `Preview body text ${id}`,
    cleaned_preview: `Cleaned preview ${id}`,
    merchant_name: "Supabase",
    merchant_domain: "supabase.io",
    order_id: `ORDER-${id}`,
    event_type: "purchase",
    amount: 124.01,
    currency: "USD",
    status: "overdue",
    receipt_date: "2026-10-04T15:30:00Z",
    gmail_internal_date: "2026-10-04T15:30:00Z",
    category: "Cloud & Infra",
    category_confidence: 0.95,
    document_kind: "invoice",
    identifiers: [{ kind: "invoice", value: `ZSUQHV-0002${id}` }],
    ...overrides,
  };
}

async function indexFor(records: ReceiptListItem[], accountKey = "owner@example.com") {
  const rows = buildRecentReceiptRows(records, accountKey);
  return { rows, index: await buildReceiptCanonicalIndex({ rows, accountKey, now: NOW }) };
}

describe("receipt canonical index", () => {
  it("is built from the same canonical rows Mail > Receipts shows, dedupe included", async () => {
    const records = [
      receipt(1, { document_kind: "invoice", identifiers: [{ kind: "order", value: "A-10" }] }),
      receipt(2, {
        document_kind: "fulfillment",
        event_type: "fulfillment",
        status: "delivered",
        identifiers: [{ kind: "order", value: "A-10" }],
      }),
      receipt(3, { identifiers: [{ kind: "order", value: "B-20" }], merchant_name: "Anthropic" }),
    ];
    const { rows, index } = await indexFor(records);
    // Three scanned messages are two canonical transactions, as the page shows.
    expect(rows).toHaveLength(2);
    expect(index.total_transactions).toBe(rows.length);
    expect(index.transactions).toHaveLength(2);
    expect(index.truncated).toBe(false);
    expect(index.generated_at).toBe("2026-10-09T10:00:00Z");
  });

  it("carries a closed set of fields and never a mailbox's raw content", async () => {
    const { index } = await indexFor([receipt(1)]);
    expect(Object.keys(index).sort()).toEqual(
      ["generated_at", "schema", "total_transactions", "transactions", "truncated"],
    );
    expect(Object.keys(index.transactions[0]!).sort()).toEqual(
      [
        "amount",
        "category",
        "currency",
        "detail",
        "identifiers",
        "merchant",
        "ref",
        "status",
        "transaction_date",
      ],
    );
    const stored = JSON.stringify(index);
    for (const raw of [
      "secretsource",
      "rawmessage",
      "rawthread",
      "billing@supabase.io",
      "Supabase Billing",
      "Snippet body text",
      "Preview body text",
      "Cleaned preview",
      "Invoice 1 from",
      "https://",
      "ORDER-1",
    ]) {
      expect(stored).not.toContain(raw);
    }
  });

  it("derives opaque refs that are stable per owner and never a provider id", async () => {
    const first = (await indexFor([receipt(1)])).index.transactions[0]!.ref;
    const again = (await indexFor([receipt(1)])).index.transactions[0]!.ref;
    const otherOwner = (await indexFor([receipt(1)], "other@example.com")).index.transactions[0]!.ref;
    expect(first).toMatch(/^txn_[0-9a-f]{24}$/);
    expect(again).toBe(first);
    expect(otherOwner).not.toBe(first);
  });

  it("never gives two transactions the same ref, even if display-group ids collide", async () => {
    const [row] = buildRecentReceiptRows([receipt(1)], "owner@example.com");
    const index = await buildReceiptCanonicalIndex({
      // The same row three times is the worst case a hash collision could produce.
      rows: [row!, row!, row!],
      accountKey: "owner@example.com",
      now: NOW,
    });
    const refs = index.transactions.map((item) => item.ref);
    expect(new Set(refs).size).toBe(3);
    expect(parseReceiptCanonicalIndex(index)).not.toBeNull();
  });

  it("keeps an amount only with its currency and types identifiers and status as the page does", async () => {
    const { index } = await indexFor([
      receipt(1, { amount: 19.999, currency: null, identifiers: [{ kind: "invoice", value: "I-1" }] }),
      receipt(2, {
        merchant_name: "Shop",
        amount: 7,
        currency: "INR",
        status: "paid",
        category: "Subscription",
        receipt_date: "2026-09-01T00:00:00Z",
        gmail_internal_date: "2026-09-01T00:00:00Z",
        identifiers: [
          { kind: "payment", value: "PAY-9" },
          { kind: "order", value: "O-2" },
          { kind: "receipt", value: "R-2" },
          { kind: "pnr", value: "PNR22" },
          { kind: "order", value: "o-2" },
        ],
      }),
    ]);
    const [noCurrency, withCurrency] = index.transactions;
    expect(noCurrency).toMatchObject({ amount: null, currency: null, status: "overdue" });
    expect(withCurrency).toMatchObject({
      amount: 7,
      currency: "INR",
      status: "paid",
      category: "Software & Subscriptions",
    });
    // A payment reference is not a transaction identifier; the rest keep their own type.
    expect(withCurrency!.identifiers).toEqual([
      { kind: "order", value: "O-2" },
      { kind: "receipt", value: "R-2" },
      { kind: "pnr", value: "PNR22" },
    ]);
  });

  it("orders newest first and keeps a calendar date a calendar date", async () => {
    const { index } = await indexFor([
      receipt(1, { merchant_name: "Old", transaction_date: "2026-08-01", identifiers: [{ kind: "order", value: "O1" }] }),
      receipt(2, {
        merchant_name: "Newer",
        transaction_date: null,
        receipt_date: "2026-10-05T03:30:00.123+00:00",
        gmail_internal_date: "2026-10-05T03:30:00.123+00:00",
        identifiers: [{ kind: "order", value: "O2" }],
      }),
      receipt(3, {
        merchant_name: "Undated",
        transaction_date: null,
        receipt_date: null,
        gmail_internal_date: null,
        identifiers: [{ kind: "order", value: "O3" }],
      }),
    ]);
    expect(index.transactions.map((item) => item.merchant)).toEqual(["Newer", "Old", "Undated"]);
    expect(index.transactions.map((item) => item.transaction_date)).toEqual([
      "2026-10-05T03:30:00Z",
      "2026-08-01",
      null,
    ]);
  });

  it("stores only the grounded short detail, link-free and markdown-inert", async () => {
    const { index } = await indexFor([
      receipt(1, { short_detail: "- Pro **plan** [monthly]", identifiers: [{ kind: "order", value: "O1" }] }),
      receipt(2, {
        short_detail: "Open https://pay.example/now",
        identifiers: [{ kind: "order", value: "O2" }],
        merchant_name: "Second",
      }),
      receipt(3, {
        short_detail: null,
        // A clean subject is still raw email content and is never a fallback.
        subject: "Plain subject line",
        identifiers: [{ kind: "order", value: "O3" }],
        merchant_name: "Third",
      }),
    ]);
    const details = Object.fromEntries(index.transactions.map((item) => [item.merchant, item.detail]));
    expect(details.Supabase).toBe("Pro plan monthly");
    // A link-bearing detail is dropped whole; the subject line is never a fallback.
    expect(details.Second).toBeNull();
    expect(details.Third).toBeNull();
  });

  it("is bounded: only the newest 100 are stored and the rest are counted", async () => {
    const records = Array.from({ length: 130 }, (_, n) =>
      receipt(n + 1, {
        merchant_name: `Shop ${n + 1}`,
        receipt_date: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString(),
        gmail_internal_date: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString(),
        identifiers: [{ kind: "order", value: `O-${n + 1}` }],
      }),
    );
    const { index } = await indexFor(records);
    expect(index.transactions).toHaveLength(RECEIPT_INDEX_MAX_TRANSACTIONS);
    expect(index.total_transactions).toBe(130);
    expect(index.truncated).toBe(true);
    expect(index.transactions[0]!.merchant).toBe("Shop 130");
    expect(index.transactions.at(-1)!.merchant).toBe("Shop 31");
  });

  it("round-trips through the reader's closed schema and refuses anything extra", async () => {
    const { index } = await indexFor([receipt(1)]);
    expect(parseReceiptCanonicalIndex(index)).toEqual(index);
    expect(readReceiptCanonicalIndex({ receipts_memory: { [RECEIPT_INDEX_BRANCH]: index } })).toEqual(index);
    const smuggled = {
      ...index,
      transactions: [{ ...index.transactions[0], subject: "Invoice 1 from Supabase" }],
    };
    expect(parseReceiptCanonicalIndex(smuggled)).toBeNull();
    expect(parseReceiptCanonicalIndex({ ...index, body: "x" })).toBeNull();
    expect(parseReceiptCanonicalIndex({ ...index, truncated: true })).toBeNull();
    expect(readReceiptCanonicalIndex({ receipts_memory: {} })).toBeNull();
    expect(readReceiptCanonicalIndex(null)).toBeNull();
  });

  it("fingerprints content, not the moment of the save", async () => {
    const records = [receipt(1)];
    const rows = buildRecentReceiptRows(records, "owner");
    const early = await buildReceiptCanonicalIndex({ rows, accountKey: "owner", now: NOW });
    const late = await buildReceiptCanonicalIndex({
      rows,
      accountKey: "owner",
      now: new Date("2026-10-20T00:00:00Z"),
    });
    expect(late.generated_at).not.toBe(early.generated_at);
    expect(await receiptIndexDigest(late)).toBe(await receiptIndexDigest(early));
    const changed = await buildReceiptCanonicalIndex({
      rows: buildRecentReceiptRows([receipt(1, { amount: 5 })], "owner"),
      accountKey: "owner",
      now: NOW,
    });
    expect(await receiptIndexDigest(changed)).not.toBe(await receiptIndexDigest(early));
  });

  it("extends an existing receipts memory without rewriting its summary fields", async () => {
    const { index } = await indexFor([receipt(1), receipt(2, { identifiers: [{ kind: "order", value: "O2" }] })]);
    const digest = await receiptIndexDigest(index);
    const existing = {
      schema_version: 1,
      readable_summary: {
        text: "Kai sees strong receipt signals around Amazon.",
        highlights: ["Top merchants: Amazon"],
        updated_at: "2026-04-01T00:00:00Z",
        source_label: "Gmail receipts",
      },
      observed_facts: { merchant_affinity: [{ merchant_id: "amazon" }], purchase_patterns: [], recent_highlights: [] },
      inferred_preferences: { preference_signals: [{ signal_id: "s1" }] },
      provenance: { source_kind: "gmail_receipts", artifact_id: "artifact-1", receipt_count_used: 3 },
    };
    const merged = mergeReceiptsMemoryWithIndex({ existing, index, digest, now: NOW });
    expect(merged.readable_summary).toBe(existing.readable_summary);
    expect(merged.observed_facts).toBe(existing.observed_facts);
    expect(merged.inferred_preferences).toBe(existing.inferred_preferences);
    expect(merged.provenance).toMatchObject({
      artifact_id: "artifact-1",
      canonical_index_digest: digest,
      receipt_count_used: index.total_transactions,
    });
    expect(merged[RECEIPT_INDEX_BRANCH]).toBe(index);

    const fresh = mergeReceiptsMemoryWithIndex({ existing: undefined, index, digest, now: NOW });
    expect(fresh.readable_summary).toMatchObject({ source_label: "Gmail receipts" });
    expect(fresh.observed_facts).toEqual({ merchant_affinity: [], purchase_patterns: [], recent_highlights: [] });
    expect(fresh.inferred_preferences).toEqual({ preference_signals: [] });
  });
});
