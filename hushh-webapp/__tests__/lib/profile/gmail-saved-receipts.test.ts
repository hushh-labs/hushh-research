import { describe, expect, it } from "vitest";

import {
  RECEIPT_INDEX_SCHEMA,
  type ReceiptCanonicalIndex,
  type ReceiptIndexTransaction,
} from "@/lib/profile/gmail-receipt-memory-index";
import { savedReceiptChatActions, savedReceiptView } from "@/lib/profile/gmail-saved-receipts";

function txn(n: number, over: Partial<ReceiptIndexTransaction> = {}): ReceiptIndexTransaction {
  return {
    ref: `txn_${n.toString(16).padStart(24, "0")}`,
    merchant: "Supabase",
    amount: 124.01,
    currency: "USD",
    category: "Cloud & Infra",
    status: "paid",
    transaction_date: "2026-10-04",
    identifiers: [],
    detail: null,
    logo_domain: null,
    ...over,
  };
}

function indexOf(transactions: ReceiptIndexTransaction[]): ReceiptCanonicalIndex {
  return {
    schema: RECEIPT_INDEX_SCHEMA,
    generated_at: "2026-10-09T10:00:00Z",
    total_transactions: transactions.length,
    truncated: false,
    transactions,
    account_ref: null,
  };
}

describe("savedReceiptView", () => {
  it("is empty when nothing is saved, so the page shows its Start sync hero", () => {
    expect(savedReceiptView(null)).toBeNull();
    expect(savedReceiptView(indexOf([]))).toBeNull();
  });

  it("keeps every saved transaction as its own row, even identical ones with no identifier", () => {
    // The saved index is already canonical; rebuilding rows through the live
    // grouping could merge look-alike receipts and so disagree with Chat.
    const view = savedReceiptView(indexOf([txn(1), txn(2), txn(3, { status: "renewal_due" })]))!;
    expect(view.rows).toHaveLength(3);
    expect(new Set(view.rows.map((row) => row.id)).size).toBe(3);
    expect(view.items.map((item) => item.source_id)).toEqual(view.rows.map((row) => row.primaryReceiptKey));
  });

  it("marks every saved record complete so opening it never reads Mail", () => {
    const view = savedReceiptView(indexOf([txn(1)]))!;
    expect(view.items[0]!.source_evidence).toEqual([]);
    expect(view.items[0]!.gmail_message_id).toBe("");
    // No email text rides along: no link, address, or non-empty subject.
    expect(JSON.stringify(view)).not.toMatch(/https?:|@/i);
    expect(view.rows[0]!.eventTimeline.every((event) => event.subject === null)).toBe(true);
    expect(view.items[0]!.subject ?? null).toBeNull();
    expect(view.items[0]!.from_email ?? null).toBeNull();
  });

  it("keeps a calendar date on its own day wherever the device is", () => {
    const row = savedReceiptView(indexOf([txn(1, { transaction_date: "2026-10-04" })]))!.rows[0]!;
    const shown = new Date(row.receiptDate!);
    expect([shown.getFullYear(), shown.getMonth() + 1, shown.getDate()]).toEqual([2026, 10, 4]);
    expect(row.secondaryMeta).toContain("Oct 4");
  });

  it("carries a logo domain only beside a named merchant", () => {
    const named = savedReceiptView(indexOf([txn(1, { merchant: "Amazon", logo_domain: "amazon.com" })]))!;
    expect(named.rows[0]!.logoDomain).toBe("amazon.com");
    const unnamed = savedReceiptView(
      indexOf([txn(2, { merchant: null, logo_domain: "amazon.com", category: "Food" })]),
    )!;
    expect(unnamed.rows[0]!.logoDomain).toBeNull();
    expect(unnamed.rows[0]!.displayKind).toBe("category");
    expect(unnamed.rows[0]!.merchantName).toBe("Food");
    const generic = savedReceiptView(indexOf([txn(3, { merchant: null, category: null })]))!;
    expect(generic.rows[0]!.displayKind).toBe("generic");
    expect(generic.rows[0]!.merchantName).toBe("Receipt");
  });

  it("shows an overdue receipt as needing attention, from its saved status only", () => {
    const row = savedReceiptView(indexOf([txn(1, { status: "overdue" })]))!.rows[0]!;
    expect(row.attentionState).toBe("needs_attention");
    expect(row.secondaryMeta).toMatch(/^Overdue/);
    expect(savedReceiptView(indexOf([txn(2, { status: "paid" })]))!.rows[0]!.attentionState).toBe("none");
  });

  it("omits an unavailable amount instead of inventing one", () => {
    const row = savedReceiptView(indexOf([txn(1, { amount: null, currency: null })]))!.rows[0]!;
    expect(row.amount).toBeNull();
    expect(row.currency).toBeNull();
  });

  it("carries a saved action to the row and the detail record, as the sealed reference only", () => {
    const action = { kind: "pay_due" as const, ref: `ra1.${"Z".repeat(40)}` };
    const view = savedReceiptView(indexOf([txn(1, { status: "overdue", action }), txn(2)]))!;
    expect(view.rows[0]!.action).toEqual(action);
    expect(view.items[0]!.action).toEqual(action);
    expect(view.rows[1]!.action).toBeNull();
    expect(view.items[1]!.action).toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/https?:/);
  });
});

describe("savedReceiptChatActions", () => {
  const refOf = (n: number) => txn(n).ref;
  const cited = (...numbers: number[]) => numbers.map((n) => `receipt:${refOf(n)}`);
  const action = (kind: "pay_due" | "view_receipt" | "view_invoice", n: number) => ({
    kind,
    ref: `ra1.${String(n).repeat(40)}`,
  });

  it("offers an action only for a cited receipt that has a verified one", () => {
    const index = indexOf([txn(1, { action: action("view_receipt", 1) }), txn(2), txn(3)]);
    expect(savedReceiptChatActions(index, cited(2, 3))).toEqual([]);
    expect(savedReceiptChatActions(index, cited(1, 2)).map((item) => item.ref)).toEqual([refOf(1)]);
    // A receipt that was not cited is never offered, even with an action.
    expect(savedReceiptChatActions(index, cited(2))).toEqual([]);
    expect(savedReceiptChatActions(null, cited(1))).toEqual([]);
  });

  it("names the receipt by merchant, then category, and carries the sealed action only", () => {
    const index = indexOf([
      txn(1, { merchant: "Kyari", action: action("view_invoice", 1) }),
      txn(2, { merchant: null, category: "Cloud & Infra", action: action("view_receipt", 2) }),
    ]);
    const offered = savedReceiptChatActions(index, cited(1, 2));
    expect(offered.map((item) => item.label)).toEqual(["Kyari", "Cloud & Infra"]);
    expect(offered[0]!.action).toEqual(action("view_invoice", 1));
    expect(JSON.stringify(offered)).not.toMatch(/https?:/);
  });

  it("always surfaces a due payment, but offers view links only beside a short answer", () => {
    const many = Array.from({ length: 5 }, (_, i) => i + 1);
    const index = indexOf([
      ...many.map((n) => txn(n, { action: action("view_receipt", n) })),
      txn(6, { status: "overdue", action: action("pay_due", 6) }),
    ]);
    // Six receipts cited: only the payment is worth a button.
    expect(savedReceiptChatActions(index, cited(1, 2, 3, 4, 5, 6)).map((item) => item.action.kind))
      .toEqual(["pay_due"]);
    // Three cited: the view links appear, payment first.
    expect(savedReceiptChatActions(index, cited(1, 2, 6)).map((item) => item.action.kind))
      .toEqual(["pay_due", "view_receipt", "view_receipt"]);
  });

  it("ignores a cited reference that is not a saved receipt reference", () => {
    const index = indexOf([txn(1, { action: action("view_receipt", 1) })]);
    expect(savedReceiptChatActions(index, [refOf(1), "mail:1", "receipt:nope"])).toEqual([]);
  });
});
