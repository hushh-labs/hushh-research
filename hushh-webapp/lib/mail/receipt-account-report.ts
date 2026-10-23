import { localDay, minor, money, paidReceiptMoney, parseReceiptAnalysisRequest } from "./receipt-analysis";
import { validateReceiptSnapshot, type ReceiptSnapshot, type SnapshotRow } from "./receipt-snapshot";

export type ReceiptAccountSource = { snapshot: ReceiptSnapshot; revision: number };
export type ReceiptReportRequest = { from_date: string; to_date: string; timezone: string; recurring_only: boolean };
type Candidate = { account: string; row: SnapshotRow; day: string | null };
type ReportCharge = { account: string; ref: string; merchant: string; date: string; amount: string; currency: string };

/** Validate the date range using the same contract as the existing receipt tools. */
function reportRange(request: ReceiptReportRequest) {
  const { recurring_only, ...range } = request;
  if (typeof recurring_only !== "boolean") throw new Error("Choose a report type.");
  return parseReceiptAnalysisRequest("receipt_spending", { ...range, group_by: "merchant" });
}

function candidateDay(row: SnapshotRow, timezone: string): string | null {
  // Verbatim source dates may be human-readable or incomplete. Never infer a year.
  if (!row.transaction_date || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(row.transaction_date) ||
      !Number.isFinite(Date.parse(row.transaction_date))) return null;
  return localDay(row.transaction_date, timezone);
}

function identities(row: SnapshotRow): string[] {
  // No merchant-name, amount or date heuristics decide transaction identity.
  // Only a reviewed seller identity and an explicit transaction reference can match.
  if (!row.brand) return [];
  return row.identifiers.filter(id => ["invoice", "receipt", "payment", "order"].includes(id.kind))
    .map(id => JSON.stringify([row.brand, id.kind, id.value]));
}

function conflictSignature(item: Candidate): string {
  const paid = paidReceiptMoney(item.row);
  return JSON.stringify([item.day, paid?.currency, paid ? money(minor(paid.amount)) : null,
    item.row.status, item.row.recurrence, item.row.events.some(e => e.kind === "refund" || e.kind === "cancellation")]);
}

function ambiguousReferences(group: Candidate[]): boolean {
  if (new Set(group.map(item => item.account)).size !== group.length) return true;
  const values = new Map<string, Set<string>>();
  for (const item of group) for (const id of item.row.identifiers) {
    const set = values.get(id.kind) ?? new Set<string>(); set.add(id.value); values.set(id.kind, set);
  }
  return [...values.values()].some(set => set.size > 1);
}

/** Cross-mailbox conflicts stay unresolved; a forwarded copy never wins by arrival order. */
function deduplicate(candidates: Candidate[]) {
  const parents = candidates.map((_, index) => index);
  const root = (index: number): number => {
    while (parents[index] !== index) { parents[index] = parents[parents[index]!]!; index = parents[index]!; }
    return index;
  };
  const seen = new Map<string, number>();
  candidates.forEach((item, index) => {
    for (const identity of identities(item.row)) {
      const previous = seen.get(identity);
      if (previous !== undefined) parents[root(index)] = root(previous);
      else seen.set(identity, index);
    }
  });
  const groups = new Map<number, Candidate[]>();
  candidates.forEach((item, index) => {
    const key = root(index); const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
  });
  const unique: Candidate[] = []; let duplicateCopies = 0; let conflicts = 0;
  for (const group of groups.values()) {
    // Existing canonical groups own deduplication inside a mailbox.
    if (new Set(group.map(item => item.account)).size === 1) { unique.push(...group); continue; }
    if (ambiguousReferences(group) || new Set(group.map(conflictSignature)).size !== 1) { conflicts += group.length; continue; }
    unique.push(group[0]!); duplicateCopies += group.length - 1;
  }
  return { unique, duplicateCopies, conflicts };
}

/** Exact observed charges with per-account provenance; never a claim of all spending. */
export function buildReceiptAccountReport(request: ReceiptReportRequest, inputs: ReceiptAccountSource[]) {
  const range = reportRange(request);
  if (inputs.length < 1 || inputs.length > 20) throw new Error("Choose between one and twenty saved mailboxes.");
  const sources = inputs.map(input => ({ ...input, snapshot: validateReceiptSnapshot(input.snapshot) }));
  if (new Set(sources.map(s => s.snapshot.account_binding)).size !== sources.length)
    throw new Error("A mailbox was selected more than once.");
  const candidates = sources.flatMap(({ snapshot }) => snapshot.rows.map(row => ({
    account: snapshot.account_binding, row, day: candidateDay(row, range.timezone),
  })));
  // Compare lifecycle evidence before date filtering, so a refund/cancellation in
  // another selected mailbox cannot be hidden by an older paid copy.
  const { unique, duplicateCopies, conflicts } = deduplicate(candidates);
  const matched = unique.filter(item => item.day && item.day >= range.from_date && item.day < range.to_date);
  const charges: ReportCharge[] = [];
  for (const item of matched) {
    const paid = paidReceiptMoney(item.row);
    if (!paid || request.recurring_only && item.row.recurrence !== "recurring") continue;
    charges.push({ account: item.account, ref: item.row.ref, merchant: item.row.merchant,
      date: item.day!, amount: money(minor(paid.amount)), currency: paid.currency });
  }
  const totals = new Map<string, bigint>();
  for (const charge of charges) totals.set(charge.currency, (totals.get(charge.currency) ?? 0n) + minor(charge.amount));
  return {
    range: { from: range.from_date, to: range.to_date, timezone: range.timezone, end_exclusive: true as const },
    recurring_only: request.recurring_only,
    accounts: sources.map(({ snapshot, revision }) => ({ binding: snapshot.account_binding,
      revision, freshness: snapshot.freshness, coverage: snapshot.coverage, canonical_count: snapshot.rows.length })),
    totals: [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, total]) => ({ currency, paid_amount: money(total) })),
    charges, duplicate_copies_removed: duplicateCopies, conflicting_records_excluded: conflicts,
    undated_records_excluded: candidates.filter(item => !item.day).length,
    unidentified_records: matched.filter(item => !identities(item.row).length).length,
    excluded_records: matched.length - charges.length,
    limitations: ["Saved receipts only; this is not your total spending.",
      "Currencies are reported separately. Refund amounts are not verified or subtracted.",
      "Only matching verified sellers and transaction references remove cross-mailbox copies. Other duplicates may remain.",
      "Recurring means a recorded recurring charge paid in this period, not a future monthly bill or a complete subscription list."],
  };
}
export type ReceiptAccountReport = ReturnType<typeof buildReceiptAccountReport>;
