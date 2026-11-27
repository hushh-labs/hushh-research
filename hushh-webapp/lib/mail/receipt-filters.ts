import type { RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import { receiptMoneyKind } from "./receipt-month-summary";

export const DATE_FILTERS = [
  { value: "all", label: "All dates" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_3_months", label: "Last 3 months" },
  { value: "this_year", label: "This year" },
  { value: "earlier", label: "Earlier" },
] as const;

export const TYPE_FILTERS = [
  { value: "all", label: "All types" },
  { value: "paid", label: "Paid" },
  { value: "recurring", label: "Recurring" },
  { value: "refunds", label: "Refunds" },
  { value: "overdue", label: "Overdue" },
  { value: "upcoming", label: "Upcoming" },
  { value: "failed", label: "Payment failed" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export type DateFilter = (typeof DATE_FILTERS)[number]["value"];
export type TypeFilter = (typeof TYPE_FILTERS)[number]["value"];

export interface ReceiptFilterSelection {
  date: DateFilter;
  type: TypeFilter;
}

export const DEFAULT_FILTERS: ReceiptFilterSelection = { date: "all", type: "all" };
const STORAGE_KEY = "hushh.mail.receipts.filters.v2";

function oneOf<T extends string>(options: readonly { value: T }[], value: unknown, fallback: T): T {
  return options.some((option) => option.value === value) ? (value as T) : fallback;
}

/**
 * Reads any earlier selection. The old unsupported "due" option, a value from a
 * newer build, or malformed data falls back to "all" instead of an empty list.
 */
export function parseFilterSelection(raw: unknown): ReceiptFilterSelection {
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  if (value === "due" || value === "paid" || value === "overdue" || value === "upcoming" || value === "cancelled") {
    // Pre-redesign builds stored a single status string.
    return { date: "all", type: oneOf(TYPE_FILTERS, value, "all") };
  }
  if (!value || typeof value !== "object") return DEFAULT_FILTERS;
  const record = value as Record<string, unknown>;
  return { date: oneOf(DATE_FILTERS, record.date, "all"), type: oneOf(TYPE_FILTERS, record.type, "all") };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function loadFilterSelection(): ReceiptFilterSelection {
  try {
    return parseFilterSelection(window.sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function saveFilterSelection(selection: ReceiptFilterSelection): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Private mode or blocked storage: the selection simply is not remembered.
  }
}

function matchesType(row: RecentReceiptRow, type: TypeFilter): boolean {
  const kind = receiptMoneyKind(row);
  switch (type) {
    case "all": return true;
    case "paid": return row.status === "paid" || row.status === "delivered" || (!row.status && kind === "payment");
    case "recurring": return row.recurrence === "recurring";
    case "refunds": return kind === "refund";
    case "overdue": return row.status === "overdue";
    case "upcoming": return row.status === "renewal_due" || row.status === "trial" || row.attentionState === "coming_up";
    case "failed": return kind === "failed";
    case "cancelled": return kind === "cancelled";
  }
}

function matchesDate(row: RecentReceiptRow, date: DateFilter, now: Date): boolean {
  if (date === "all") return true;
  const time = row.receiptDate ? new Date(row.receiptDate).getTime() : NaN;
  if (Number.isNaN(time)) return false;
  const day = 86_400_000;
  const age = now.getTime() - time;
  if (date === "last_30_days") return age <= 30 * day;
  if (date === "last_3_months") return age <= 92 * day;
  if (date === "this_year") return new Date(time).getFullYear() === now.getFullYear();
  return age > 92 * day;
}

export function filterReceiptRows(
  rows: readonly RecentReceiptRow[],
  selection: ReceiptFilterSelection,
  query: string,
  now: Date = new Date(),
): RecentReceiptRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      matchesType(row, selection.type) &&
      matchesDate(row, selection.date, now) &&
      (!needle || row.searchText.toLowerCase().includes(needle)),
  );
}
