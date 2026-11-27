import { describe, expect, it } from "vitest";

import { buildRecentReceiptRows, type RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

import { detectRecurringBills } from "../receipt-recurring-detect";
import { DEFAULT_FILTERS, filterReceiptRows, parseFilterSelection } from "../receipt-filters";
import { buildReceiptInsights } from "../receipt-insights";
import { summarizeMonth } from "../receipt-month-summary";

let counter = 0;
function receipt(over: Partial<ReceiptListItem>): ReceiptListItem {
  counter += 1;
  return {
    id: counter,
    gmail_message_id: `m${counter}`,
    receipt_key: `k${counter}`,
    source_id: `s${counter}`,
    merchant_name: "Orbit Mobile",
    merchant_domain: `merchant${counter}.example`,
    status: "paid",
    currency: "INR",
    amount: 899,
    transaction_date: "2026-12-02",
    category: "Bills",
    category_confidence: 0.95,
    recurrence: "unknown",
    ...over,
  } as ReceiptListItem;
}
const rows = (items: ReceiptListItem[]): RecentReceiptRow[] => buildRecentReceiptRows(items, "acct");
const NOW = new Date("2026-12-26T00:00:00Z");

describe("month summary", () => {
  it("counts confirmed refunds, keeps currencies apart and leaves unknown amounts out", () => {
    const month = summarizeMonth(rows([
      receipt({ merchant_name: "Maple Homes", amount: 24000 }),
      receipt({ merchant_name: "Orbit Mobile", amount: 899 }),
      receipt({ merchant_name: "Shoe Store", amount: 1000, status: "refunded", event_type: "refund" }),
      receipt({ merchant_name: "Globex", amount: 12.5, currency: "USD" }),
      receipt({ merchant_name: "Mystery", amount: null }),
      receipt({ merchant_name: "Broken Bank", amount: 5000, status: "payment_failed" }),
    ]));
    expect(month.paymentCount).toBe(4);
    expect(month.refundCount).toBe(1);
    expect(month.net).toEqual([{ currency: "INR", minor: 2389900 }, { currency: "USD", minor: 1250 }]);
    expect(month.unknownAmountCount).toBe(1);
  });

  it("never counts a failed charge as money spent", () => {
    const month = summarizeMonth(rows([receipt({ amount: 5000, status: "payment_failed" })]));
    expect([month.paymentCount, month.net]).toEqual([0, []]);
  });
});

describe("filters", () => {
  it("falls back to All for the retired Due option and for anything unrecognised", () => {
    expect(parseFilterSelection("due")).toEqual(DEFAULT_FILTERS);
    expect(parseFilterSelection('{"date":"someday","type":"due"}')).toEqual(DEFAULT_FILTERS);
    expect(parseFilterSelection("overdue")).toEqual({ date: "all", type: "overdue" });
    expect(parseFilterSelection(null)).toEqual(DEFAULT_FILTERS);
  });

  it("filters by date and type together with search", () => {
    const all = rows([
      receipt({ merchant_name: "Orbit Mobile", transaction_date: "2026-12-02" }),
      receipt({ merchant_name: "Maple Homes", transaction_date: "2026-03-01", recurrence: "recurring" }),
    ]);
    expect(filterReceiptRows(all, { date: "last_30_days", type: "all" }, "", NOW).map((r) => r.merchantName)).toEqual(["Orbit Mobile"]);
    expect(filterReceiptRows(all, { date: "all", type: "recurring" }, "", NOW).map((r) => r.merchantName)).toEqual(["Maple Homes"]);
    expect(filterReceiptRows(all, DEFAULT_FILTERS, "maple", NOW)).toHaveLength(1);
  });
});

describe("insights", () => {
  const plan = (name: string, amount: number) =>
    ["2026-10-04", "2026-11-04", "2026-12-04"].map((date) =>
      receipt({ merchant_name: name, amount, transaction_date: date, category: "Software & Subscriptions", recurrence: "recurring" }));

  it("links overlapping plans to their receipts and totals the month only when each plan is monthly", () => {
    const insights = buildReceiptInsights(rows([...plan("Alpha TV", 299), ...plan("Beta Stream", 499), ...plan("Gamma Play", 199)]), NOW);
    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({ kind: "overlapping_plans", title: "You pay for 3 subscription plans", action: { label: "Review plans" } });
    expect(insights[0]!.reason).toContain("₹997 a month");
    expect(insights[0]!.receiptKeys).toHaveLength(3);
  });

  it("does not raise an overlap for two plans or for a plan the user cancelled", () => {
    expect(buildReceiptInsights(rows([...plan("Alpha TV", 299), ...plan("Beta Stream", 499)]), NOW)).toEqual([]);
    const cancelled = receipt({ merchant_name: "Gamma Play", transaction_date: "2026-12-10", status: "cancelled", event_type: "cancellation", category: "Software & Subscriptions" });
    const kinds = buildReceiptInsights(rows([...plan("Alpha TV", 299), ...plan("Beta Stream", 499), ...plan("Gamma Play", 199), cancelled]), NOW).map((i) => i.kind);
    expect(kinds).not.toContain("overlapping_plans");
  });

  it("flags a possible double charge but leaves distinct orders separate", () => {
    const twice = rows([
      receipt({ merchant_name: "Cafe", amount: 450, transaction_date: "2026-12-20" }),
      receipt({ merchant_name: "Cafe", amount: 450, transaction_date: "2026-12-21" }),
    ]);
    expect(buildReceiptInsights(twice, NOW).map((i) => i.kind)).toEqual(["duplicate_charge"]);
    const separate = rows([
      receipt({ merchant_name: "Cafe", amount: 450, transaction_date: "2026-12-20", identifiers: [{ kind: "order", value: "A-1" }] }),
      receipt({ merchant_name: "Cafe", amount: 450, transaction_date: "2026-12-21", identifiers: [{ kind: "order", value: "A-2" }] }),
    ]);
    expect(buildReceiptInsights(separate, NOW)).toEqual([]);
    expect(separate).toHaveLength(2);
  });

  it("flags a cancellation with no refund after a week, and stops once a refund exists", () => {
    const purchase = receipt({ merchant_name: "Shoe Store", amount: 2500, transaction_date: "2026-12-01" });
    const cancel = receipt({ merchant_name: "Shoe Store", amount: 2500, transaction_date: "2026-12-05", status: "cancelled", event_type: "cancellation" });
    expect(buildReceiptInsights(rows([purchase, cancel]), NOW).map((i) => i.kind)).toEqual(["missing_refund"]);
    const refund = receipt({ merchant_name: "Shoe Store", amount: 2500, transaction_date: "2026-12-12", status: "refunded", event_type: "refund" });
    expect(buildReceiptInsights(rows([purchase, cancel, refund]), NOW)).toEqual([]);
  });
});

describe("recurring detection", () => {
  it("finds a fixed monthly bill and cites the receipts, without any authority", () => {
    const rent = ["2026-09-01", "2026-10-02", "2026-11-01", "2026-12-01"].map((date) =>
      receipt({ merchant_name: "Maple Homes", amount: 24000, transaction_date: date }));
    const [bill] = detectRecurringBills(rows(rent), NOW);
    expect(bill).toMatchObject({ kind: "fixed", frequency: "monthly", agreedMinor: 2400000, nextOn: "2027-01-01" });
    expect(bill!.reason).toBe("Four receipts show ₹24,000 paid around the 1st to 2nd.");
    expect(bill!.evidence).toHaveLength(4);
  });

  it("calls a bill variable when amounts differ, and ignores irregular purchases", () => {
    const power = [["2026-09-26", 1420], ["2026-10-26", 1470], ["2026-11-26", 1780]].map(([date, amount]) =>
      receipt({ merchant_name: "City Power", amount: amount as number, transaction_date: date as string }));
    expect(detectRecurringBills(rows(power), NOW)[0]).toMatchObject({ kind: "variable", agreedMinor: null });
    const random = ["2026-09-03", "2026-09-29", "2026-12-01"].map((date) => receipt({ merchant_name: "Corner Shop", transaction_date: date }));
    expect(detectRecurringBills(rows(random), NOW)).toEqual([]);
  });
});
