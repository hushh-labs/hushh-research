import { validateReceiptSnapshot, type ReceiptSnapshot, type SnapshotRow } from "./receipt-snapshot";

export const RECEIPT_FUNCTIONS = ["list_recent_receipts", "receipt_spending", "highest_receipt_spend", "most_frequently_purchased_products"] as const;
export type ReceiptFunction = typeof RECEIPT_FUNCTIONS[number];
export type ReceiptAnalysisRequest = { from_date: string; to_date: string; timezone: string; group_by?: "merchant" | "category" | "product"; limit?: number };
export function parseReceiptAnalysisRequest(operation: ReceiptFunction, value: unknown): ReceiptAnalysisRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A receipt date range is required.");
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(k => !["from_date", "to_date", "timezone", "group_by", "limit"].includes(k)) ||
    typeof r.from_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.from_date) || typeof r.to_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.to_date) || r.from_date >= r.to_date ||
    new Date(r.from_date).toISOString().slice(0, 10) !== r.from_date || new Date(r.to_date).toISOString().slice(0, 10) !== r.to_date ||
    typeof r.timezone !== "string" || r.timezone.length > 80 ||
    (r.limit != null && (!Number.isInteger(r.limit) || Number(r.limit) < 1 || Number(r.limit) > 25)) ||
    (["receipt_spending", "highest_receipt_spend"].includes(operation) && (typeof r.group_by !== "string" || !["merchant", "category", "product"].includes(r.group_by))) ||
    (!["receipt_spending", "highest_receipt_spend"].includes(operation) && r.group_by !== undefined)) throw new Error("Invalid receipt function request.");
  new Intl.DateTimeFormat("en", { timeZone: r.timezone }).format();
  return { from_date: r.from_date, to_date: r.to_date, timezone: r.timezone, ...(r.group_by ? { group_by: r.group_by as ReceiptAnalysisRequest["group_by"] } : {}), limit: Number(r.limit ?? 10) };
}
// All current verified source currencies have two minor units. No binary float
// participates in a sum, comparison or net calculation.
function minor(amount: string): bigint { const [whole, fraction = ""] = amount.split("."); return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0")); }
function money(value: bigint): string { return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`; }
function localDay(value: string, timezone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function paidReceiptMoney(row: SnapshotRow): { amount: string; currency: string } | null {
  if (["cancelled", "trial", "payment_failed", "overdue", "suspended", "renewal_due", "refunded"].includes(row.status ?? "") || row.events.some(e => e.kind === "cancellation" || e.kind === "refund")) return null;
  const evidence = row.events.filter(e => e.status === "paid" && e.kind === "purchase" && e.amount !== null && e.currency && /^[A-Z]{3}$/.test(e.currency));
  const values = new Set(evidence.map(e => `${e.currency}:${minor(e.amount!)}`));
  // Delivered alone isn't payment evidence; inconsistent paid values stay unknown.
  return values.size === 1 ? { amount: evidence[0]!.amount!, currency: evidence[0]!.currency! } : null;
}
export function analyzeReceipts(operation: ReceiptFunction, input: unknown, source: ReceiptSnapshot, revision: number) {
  const request = parseReceiptAnalysisRequest(operation, input);
  const snapshot = validateReceiptSnapshot(source);
  const matched = snapshot.rows.filter(r => r.transaction_date && (() => { const day = localDay(r.transaction_date, request.timezone); return day >= request.from_date && day < request.to_date; })());
  const refunds = matched.filter(r => r.status === "refunded" || r.events.some(e => e.kind === "refund"));
  const included = matched.filter(r => paidReceiptMoney(r));
  const base = {
    schema: "receipt_analysis.v1" as const, operation, requested_range: { from: request.from_date, to: request.to_date, end_exclusive: true, timezone: request.timezone },
    source_freshness: snapshot.freshness, snapshot_revision: revision,
    canonical_transaction_count: snapshot.rows.length, matched_count: matched.length, included_count: operation === "list_recent_receipts" ? matched.length : included.length,
    coverage: { ...snapshot.coverage, undated_count: snapshot.rows.filter(r => !r.transaction_date).length, excluded_from_paid_count: matched.length - included.length },
    truncated: false, dedupe_policy: "Mail canonical groups; one transaction per saved group; refunds/cancellations remain separate",
    refund_handling: { record_count: refunds.length, amount: null, net: null, policy: "Refund events are separate. The current source does not verify refund amounts or allocation; never subtract an order total as a refund." },
    cancellation_handling: "Unpaid, failed, cancelled, trial, suspended and due records excluded. Delivered requires separate paid evidence.",
    limitations: ["Observed Mail receipts only; not all purchases.", "No currency conversion. Ambiguous $ excluded from paid totals.", "Unverified or conflicting payment evidence excluded.", "Product and refund amount evidence unavailable."],
  };
  if (request.group_by === "product" || operation === "most_frequently_purchased_products")
    return { ...base, status: "unsupported", unsupported: "product_data_unavailable", included_count: 0, results: [] };
  if (operation === "list_recent_receipts") {
    const sorted = [...matched].sort((a, b) => (b.transaction_date ?? "").localeCompare(a.transaction_date ?? "") || a.ref.localeCompare(b.ref));
    return { ...base, status: "ok", truncated: sorted.length > request.limit!, results: sorted.slice(0, request.limit).map(r => ({ ref: r.ref, merchant: r.merchant, category: r.category, status: r.status, transaction_date: r.transaction_date, amount: r.amount, currency: r.currency, identifiers: r.identifiers })) };
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
export function unavailableReceiptAnalysis(operation: ReceiptFunction, request: ReceiptAnalysisRequest) {
  return { schema: "receipt_analysis.v1", operation, status: "unavailable", code: "receipt_snapshot_unavailable",
    requested_range: { from: request.from_date, to: request.to_date, end_exclusive: true, timezone: request.timezone },
    source_freshness: null, snapshot_revision: null, canonical_transaction_count: null, matched_count: null, included_count: null,
    coverage: null, truncated: false, dedupe_policy: "Mail canonical groups; one transaction per saved group",
    refund_handling: { record_count: null, amount: null, net: null, policy: "Refund evidence unavailable." },
    cancellation_handling: "Unpaid, failed, cancelled and trial records are excluded from paid totals.",
    limitations: ["The owner receipt snapshot could not be read. Sync Mail Receipts and ask again."], results: [] };
}

/** These declarations are app-owned, not arbitrary client supplied tools. */
export const RECEIPT_TOOL_DECLARATIONS = RECEIPT_FUNCTIONS.map(name => ({
  name, description: `${name}: owner-authorized canonical receipt snapshot read. Money is computed on device; currencies separate. Products unsupported until structured evidence exists.`,
  parameters: { type: "object", additionalProperties: false, required: ["from_date", "to_date", "timezone", ...(["receipt_spending", "highest_receipt_spend"].includes(name) ? ["group_by"] : [])],
    properties: { from_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, to_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, timezone: { type: "string", maxLength: 80 }, limit: { type: "integer", minimum: 1, maximum: 25 },
      ...(["receipt_spending", "highest_receipt_spend"].includes(name) ? { group_by: { type: "string", enum: ["merchant", "category", "product"] } } : {}) } },
}));
