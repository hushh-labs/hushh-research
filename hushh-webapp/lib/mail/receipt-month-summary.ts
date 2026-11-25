import type { RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import { toMinor } from "./receipt-money";

/** What a saved receipt means for money, decided from its confirmed lifecycle only. */
export type ReceiptMoneyKind = "payment" | "refund" | "failed" | "cancelled" | "unpaid";

export function receiptMoneyKind(row: Pick<RecentReceiptRow, "status" | "eventTimeline" | "attentionReason">): ReceiptMoneyKind {
  const event = row.eventTimeline[0]?.eventKind;
  if (row.status === "refunded" || event === "refund") return "refund";
  if (row.status === "payment_failed" || row.attentionReason === "payment_failed") return "failed";
  if (row.status === "cancelled" || event === "cancellation") return "cancelled";
  if (row.status === "overdue" || row.status === "renewal_due" || row.status === "suspended" || row.status === "trial") return "unpaid";
  return "payment";
}

export interface MonthSummary {
  /** Receipts that are payments: a failed, cancelled or unpaid receipt is not one. */
  paymentCount: number;
  refundCount: number;
  /** Net per currency in minor units; currencies are never added together. */
  net: Array<{ currency: string; minor: number }>;
  /** Payments or refunds whose amount or currency is unknown; they stay out of the net. */
  unknownAmountCount: number;
}

export function summarizeMonth(rows: readonly RecentReceiptRow[]): MonthSummary {
  const totals = new Map<string, number>();
  let paymentCount = 0;
  let refundCount = 0;
  let unknownAmountCount = 0;
  for (const row of rows) {
    if (row.archived) continue;
    const kind = receiptMoneyKind(row);
    if (kind !== "payment" && kind !== "refund") continue;
    if (kind === "payment") paymentCount += 1;
    else refundCount += 1;
    const minor = toMinor(row.amount, row.currency);
    if (minor === null || !row.currency) {
      unknownAmountCount += 1;
      continue;
    }
    const currency = row.currency.trim().toUpperCase();
    totals.set(currency, (totals.get(currency) ?? 0) + (kind === "refund" ? -minor : minor));
  }
  const net = [...totals].map(([currency, minor]) => ({ currency, minor })).sort((a, b) => Math.abs(b.minor) - Math.abs(a.minor));
  return { paymentCount, refundCount, net, unknownAmountCount };
}
