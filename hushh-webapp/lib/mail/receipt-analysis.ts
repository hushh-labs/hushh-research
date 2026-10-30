import { validateReceiptSnapshot, type ReceiptSnapshot, type SnapshotRow } from "./receipt-snapshot";

export const RECEIPT_FUNCTIONS = ["list_recent_receipts", "receipt_spending", "highest_receipt_spend", "most_frequently_purchased_products"] as const;
export type ReceiptFunction = typeof RECEIPT_FUNCTIONS[number];
/** Mirrors the snapshot's attention_state: overdue, failed or suspended payments, or renewals due. */
export const RECEIPT_ATTENTION = ["needs_attention", "coming_up"] as const;
export type ReceiptAttention = typeof RECEIPT_ATTENTION[number];
export type ReceiptAnalysisRequest = { from_date: string; to_date: string; timezone: string; group_by?: "merchant" | "category" | "product"; limit?: number; attention?: ReceiptAttention };
const GROUPED: readonly string[] = ["receipt_spending", "highest_receipt_spend"];
export function parseReceiptAnalysisRequest(operation: ReceiptFunction, value: unknown): ReceiptAnalysisRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A receipt date range is required.");
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(k => !["from_date", "to_date", "timezone", "group_by", "limit", "attention"].includes(k)) ||
    typeof r.from_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.from_date) || typeof r.to_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.to_date) || r.from_date >= r.to_date ||
    new Date(r.from_date).toISOString().slice(0, 10) !== r.from_date || new Date(r.to_date).toISOString().slice(0, 10) !== r.to_date ||
    typeof r.timezone !== "string" || r.timezone.length > 80 ||
    (r.limit != null && (!Number.isInteger(r.limit) || Number(r.limit) < 1 || Number(r.limit) > 25)) ||
    (GROUPED.includes(operation) && (typeof r.group_by !== "string" || !["merchant", "category", "product"].includes(r.group_by))) ||
    (!GROUPED.includes(operation) && r.group_by !== undefined) ||
    (r.attention !== undefined && (operation !== "list_recent_receipts" || !RECEIPT_ATTENTION.includes(r.attention as ReceiptAttention)))) throw new Error("Invalid receipt function request.");
  new Intl.DateTimeFormat("en", { timeZone: r.timezone }).format();
  return { from_date: r.from_date, to_date: r.to_date, timezone: r.timezone, ...(r.group_by ? { group_by: r.group_by as ReceiptAnalysisRequest["group_by"] } : {}),
    limit: Number(r.limit ?? 10), ...(r.attention ? { attention: r.attention as ReceiptAttention } : {}) };
}
// All current verified source currencies have two minor units. No binary float
// participates in a sum, comparison or net calculation.
function minor(amount: string): bigint { const [whole, fraction = ""] = amount.split("."); return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0")); }
function money(value: bigint): string { return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`; }
// The hub admits only these ISO forms: a calendar date, or a date-time with an
// explicit offset. Printed receipt dates are display evidence and are never parsed.
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2}):(\d{2})))?$/;
/** Epoch milliseconds of a strict ISO date (UTC midnight) or offset date-time; null for anything else. */
function isoInstant(value: string | null | undefined): number | null {
  const m = typeof value === "string" ? ISO.exec(value) : null;
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", fraction = "", sign, oh = "0", om = "0"] = m;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59 || Number(oh) > 23 || Number(om) > 59) return null;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(fraction.padEnd(3, "0").slice(0, 3)));
  if (new Date(wall).toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return null;
  return wall - (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60_000;
}
/** The owner's calendar day for a strict ISO value. A calendar date already is one; other text is null. */
function isoDayIn(timezone: string): (value: string | null | undefined) => string | null {
  const format = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  return value => {
    const instant = isoInstant(value);
    if (instant === null || !value) return null;
    if (value.length === 10) return value;
    const parts = format.formatToParts(instant);
    const part = (type: string) => parts.find(p => p.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
}
/** transaction_date when it is ISO, else the primary event's ISO (email) date, else null: undated. */
function analysisDay(row: SnapshotRow, isoDay: (value: string | null | undefined) => string | null): string | null {
  return isoDay(row.transaction_date) ?? isoDay(row.events.find(e => e.ref === row.primary_event_ref)?.date);
}
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Deterministic coverage facts the answer must state. They describe the sync, never the purchases. */
function coverageLimitations(snapshot: ReceiptSnapshot, request: ReceiptAnalysisRequest, isoDay: (value: string | null) => string | null, now: number): string[] {
  const start = isoDay(snapshot.coverage.window_from);
  const freshness = isoInstant(snapshot.freshness);
  return [
    ...(start && request.from_date < start ? [`Receipts only go back to ${start}; earlier purchases are not included.`] : []),
    ...(snapshot.coverage.partial ? ["Receipt sync is incomplete, so some receipts may be missing."] : []),
    ...(freshness !== null && now - freshness > STALE_AFTER_MS ? [`Receipts were last updated on ${isoDay(snapshot.freshness)}.`] : []),
  ];
}
export function paidReceiptMoney(row: SnapshotRow): { amount: string; currency: string } | null {
  if (["cancelled", "trial", "payment_failed", "overdue", "suspended", "renewal_due", "refunded"].includes(row.status ?? "") || row.events.some(e => e.kind === "cancellation" || e.kind === "refund")) return null;
  const evidence = row.events.filter(e => e.status === "paid" && e.kind === "purchase" && e.amount !== null && e.currency && /^[A-Z]{3}$/.test(e.currency));
  const values = new Set(evidence.map(e => `${e.currency}:${minor(e.amount!)}`));
  // Delivered alone isn't payment evidence; inconsistent paid values stay unknown.
  return values.size === 1 ? { amount: evidence[0]!.amount!, currency: evidence[0]!.currency! } : null;
}
export function analyzeReceipts(operation: ReceiptFunction, input: unknown, source: ReceiptSnapshot, revision: number, now = Date.now()) {
  const request = parseReceiptAnalysisRequest(operation, input);
  const validated = validateReceiptSnapshot(source);
  const snapshot = { ...validated, rows: validated.rows.filter(row => !validated.sync?.archive_refs.includes(row.ref)) };
  const isoDay = isoDayIn(request.timezone);
  const days = new Map(snapshot.rows.map(row => [row.ref, analysisDay(row, isoDay)] as const));
  const dayOf = (row: SnapshotRow) => days.get(row.ref) ?? null;
  const inRange = snapshot.rows.filter(r => { const day = dayOf(r); return day !== null && day >= request.from_date && day < request.to_date; });
  // attention narrows a list to the snapshot's own attention_state; it never reclassifies a receipt.
  const matched = request.attention ? inRange.filter(r => r.attention_state === request.attention) : inRange;
  const refunds = matched.filter(r => r.status === "refunded" || r.events.some(e => e.kind === "refund"));
  const included = matched.filter(r => paidReceiptMoney(r));
  const base = {
    schema: "receipt_analysis.v1" as const, operation, requested_range: { from: request.from_date, to: request.to_date, end_exclusive: true, timezone: request.timezone },
    source_freshness: snapshot.freshness, snapshot_revision: revision,
    canonical_transaction_count: snapshot.rows.length, matched_count: matched.length, included_count: operation === "list_recent_receipts" ? matched.length : included.length,
    coverage: { ...snapshot.coverage, undated_count: snapshot.rows.filter(r => dayOf(r) === null).length, excluded_from_paid_count: matched.length - included.length },
    truncated: false, dedupe_policy: "Mail canonical groups; one transaction per saved group; refunds/cancellations remain separate",
    refund_handling: { record_count: refunds.length, amount: null, net: null, policy: "Refund events are separate. The current source does not verify refund amounts or allocation; never subtract an order total as a refund." },
    cancellation_handling: "Unpaid, failed, cancelled, trial, suspended and due records excluded. Delivered requires separate paid evidence.",
    limitations: ["Observed Mail receipts only; not all purchases.", "No currency conversion. Ambiguous $ excluded from paid totals.", "Unverified or conflicting payment evidence excluded.", "Product and refund amount evidence unavailable.",
      ...coverageLimitations(snapshot, request, isoDay, now)],
  };
  if (request.group_by === "product" || operation === "most_frequently_purchased_products")
    return { ...base, status: "unsupported", unsupported: "product_data_unavailable", included_count: 0, results: [] };
  if (operation === "list_recent_receipts") {
    // Every matched row has an ISO day; it replaces printed text, which the hub's ISO-only validator refuses.
    const sorted = [...matched].sort((a, b) => (dayOf(b) ?? "").localeCompare(dayOf(a) ?? "") || a.ref.localeCompare(b.ref));
    return { ...base, status: "ok", truncated: sorted.length > request.limit!, results: sorted.slice(0, request.limit).map(r => ({ ref: r.ref, merchant: r.merchant, category: r.category, status: r.status, transaction_date: dayOf(r), amount: r.amount, currency: r.currency, identifiers: r.identifiers })) };
  }
  const totals = new Map<string, { label: string; currency: string; amount: bigint; count: number }>();
  for (const r of included) {
    const paid = paidReceiptMoney(r)!; const label = request.group_by === "merchant" ? r.merchant : r.category ?? "Uncategorized";
    const key = JSON.stringify([paid.currency, label]);
    const entry = totals.get(key) ?? { label, currency: paid.currency, amount: 0n, count: 0 };
    entry.amount += minor(paid.amount); entry.count += 1; totals.set(key, entry);
  }
  const results = [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency) || (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.label.localeCompare(b.label)));
  // Rank within each currency. A USD group is never compared to an INR group.
  const currencies = [...new Set(results.map(r => r.currency))];
  // Exact totals cover every included canonical group, even when the ranking
  // is truncated. Chat must never sum the returned merchant/category rows.
  const currency_totals = currencies.map(currency => {
    const groups = results.filter(r => r.currency === currency);
    const amount = groups.reduce((sum, r) => sum + r.amount, 0n);
    return { currency, paid_amount: money(amount), paid_transaction_count: groups.reduce((sum, r) => sum + r.count, 0), refund_amount: null, net_amount: refunds.length ? null : money(amount) };
  });
  let truncated = false;
  const ranked = currencies.flatMap(currency => {
    const groups = results.filter(r => r.currency === currency);
    if (groups.length > request.limit!) truncated = true;
    return groups.slice(0, request.limit).map((r, index) => ({ label: r.label, currency, paid_amount: money(r.amount), paid_transaction_count: r.count, rank: index + 1, refund_amount: null, net_amount: refunds.length ? null : money(r.amount) }));
  });
  return { ...base, status: "ok", group_by: request.group_by, truncated, currency_totals, results: ranked };
}
export type ReceiptAnalysisResult = ReturnType<typeof analyzeReceipts>;

const RANGE_RULE = "from_date is inclusive and to_date exclusive (YYYY-MM-DD). Pass timezone exactly as the instruction gives it.";
/** Same text as the hub's RECEIPT_FUNCTION_DESCRIPTIONS; the hub serves its own copy to the model. */
export const RECEIPT_FUNCTION_DESCRIPTIONS: Record<ReceiptFunction, string> = {
  list_recent_receipts: `List synced receipts, newest first, each with its status such as paid, overdue or payment_failed. ${RANGE_RULE} Each date is the receipt's date when readable, otherwise the email's date.`,
  receipt_spending: `Spending totals, computed on device from synced receipts and grouped by merchant or category. ${RANGE_RULE} currency_totals gives one exact total per currency; never add currencies together. group_by product is unsupported.`,
  highest_receipt_spend: `Rank merchants or categories by spending within each currency, computed on device from synced receipts. ${RANGE_RULE} group_by product is unsupported.`,
  most_frequently_purchased_products: `Product purchase counts are not available yet; this returns unsupported. ${RANGE_RULE}`,
};
/**
 * These declarations are app-owned, not arbitrary client supplied tools. The hub admits only these
 * exact parameters. Expand phase: requests may carry `attention`, but the declared list schema stays
 * pre-attention until every hub and owner pod admits it (an older pod refuses unknown schemas).
 */
export const RECEIPT_TOOL_DECLARATIONS = RECEIPT_FUNCTIONS.map(name => ({
  name, description: RECEIPT_FUNCTION_DESCRIPTIONS[name],
  parameters: { type: "object", additionalProperties: false, required: ["from_date", "to_date", "timezone", ...(GROUPED.includes(name) ? ["group_by"] : [])],
    properties: { from_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, to_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, timezone: { type: "string", maxLength: 80 }, limit: { type: "integer", minimum: 1, maximum: 25 },
      ...(GROUPED.includes(name) ? { group_by: { type: "string", enum: ["merchant", "category", "product"] } } : {}) } },
}));
