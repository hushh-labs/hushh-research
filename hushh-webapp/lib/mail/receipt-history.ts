import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
import { receiptAccountBinding } from "./receipt-snapshot";

export const RECEIPT_HISTORY_KEY = "mail_receipt_history.v1";
type SavedRow = { ref: string; merchant: string | null; order: string | null; date: string | null; amount: string | null; currency: string | null };
export type ReceiptHistory = { schema: "mail_receipt_history.v1"; source: "legacy_server_read_only"; account_binding: "unknown"; partial: boolean; next_page: number | null; rows: SavedRow[] };
const safeText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f]|https?:|www\.|@/i.test(value);
const decimal = (value: unknown): value is string => typeof value === "string" && /^-?\d{1,14}(?:\.\d{1,4})?$/.test(value);
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !(key in value)))
    throw new Error("Saved receipt history could not be verified.");
}
export function validateReceiptHistory(value: unknown): ReceiptHistory {
  closed(value, ["schema", "source", "account_binding", "partial", "next_page", "rows"]);
  if (value.schema !== "mail_receipt_history.v1" || value.source !== "legacy_server_read_only" || value.account_binding !== "unknown" ||
      typeof value.partial !== "boolean" || (value.partial ? !Number.isSafeInteger(value.next_page) || Number(value.next_page) < 1 || Number(value.next_page) > 101 : value.next_page !== null) || !Array.isArray(value.rows) || value.rows.length > 10000 || JSON.stringify(value).length > 4_000_000)
    throw new Error("Saved receipt history could not be verified.");
  const refs = new Set<string>();
  for (const row of value.rows) {
    closed(row, ["ref", "merchant", "order", "date", "amount", "currency"]);
    if (typeof row.ref !== "string" || !/^[a-f0-9]{64}$/.test(row.ref) || refs.has(row.ref) ||
        ![row.merchant, row.order, row.date].every(field => field === null || safeText(field, 200)) ||
        row.amount !== null && !decimal(row.amount) || row.currency !== null && !safeText(row.currency, 8))
      throw new Error("Saved receipt history could not be verified.");
    refs.add(row.ref);
  }
  return value as unknown as ReceiptHistory;
}
/** Archive only known columns. No email prose, provider identifiers, account
 * assertion, extraction or live provider locator enters this record. The page position is
 * only for the immutable owner archive. */
export async function captureReceiptHistory(items: readonly ReceiptListItem[], previous: ReceiptHistory | null, partial: boolean, nextPage: number | null = partial ? 1 : null): Promise<ReceiptHistory> {
  const rows = new Map((previous?.rows ?? []).map(row => [row.ref, row]));
  for (const item of items) {
    if (!Number.isSafeInteger(item.id) || item.id < 0) throw new Error("Saved receipt identity could not be verified.");
    const ref = await receiptAccountBinding(`legacy-owner-receipt:${item.id}`);
    const amount = item.amount_decimal ?? (item.amount === null || item.amount === undefined ? null : String(item.amount));
    if (amount !== null && !decimal(amount)) throw new Error("A saved receipt amount could not be preserved.");
    const field = (value: unknown) => safeText(value, 200) ? value : null;
    rows.set(ref, { ref, merchant: field(item.merchant_name), order: field(item.order_id), date: field(item.receipt_date ?? item.gmail_internal_date),
      amount, currency: item.currency === null || item.currency === undefined ? null : safeText(item.currency, 8) ? item.currency : null });
  }
  return validateReceiptHistory({ schema: "mail_receipt_history.v1", source: "legacy_server_read_only", account_binding: "unknown", partial, next_page: nextPage, rows: [...rows.values()] });
}
export function receiptHistoryItems(value: ReceiptHistory): ReceiptListItem[] {
  return validateReceiptHistory(value).rows.map((row, index) => ({ id: index, source_id: row.ref, receipt_key: row.ref, source_kind: "legacy_read_only",
    gmail_message_id: "", merchant_name: row.merchant, order_id: row.order, receipt_date: row.date, transaction_date: row.date,
    amount: row.amount === null ? null : Number(row.amount), amount_decimal: row.amount, currency: row.currency }));
}
