/** Mail owns canonical transactions. PKM receives only an aggregate projection. */
import { buildRecentReceiptRows, receiptDocumentLabel, receiptAttentionLabel, receiptStatusLabel, type RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import { DurableResourceError } from "@/lib/services/durable-resource-error";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
import { resolveSavedReceiptMerchantBrand, isVerifiedReceiptMerchantKey, type VerifiedReceiptMerchantKey } from "@/lib/mail/receipt-merchant-registry";

export const RECEIPT_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const RECEIPT_MEMORY_MAX_BYTES = 16 * 1024;
export const RECEIPT_SNAPSHOT_PREFIX = "mail_receipts.v1:";
export type Event = {
  ref: string; locator: string | null; document_kind: ReceiptListItem["document_kind"];
  status: RecentReceiptRow["status"]; kind: NonNullable<ReceiptListItem["event_type"]>;
  date: string | null; amount: string | null; currency: string | null;
};
export type SnapshotRow = {
  ref: string; display_id: string; primary_event_ref: string; merchant: string; category: RecentReceiptRow["category"];
  display_kind: RecentReceiptRow["displayKind"]; brand: VerifiedReceiptMerchantKey | null;
  amount: string | null; currency: string | null; transaction_date: string | null;
  identifiers: RecentReceiptRow["identifiers"]; status: RecentReceiptRow["status"];
  recurrence: RecentReceiptRow["recurrence"]; attention_state: RecentReceiptRow["attentionState"];
  attention_reason: RecentReceiptRow["attentionReason"]; attention_is_prediction: boolean;
  attention_date: string | null; document_kind: ReceiptListItem["document_kind"];
  confidence: number | null; events: Event[];
};
export type ReceiptSyncRecord = { row: SnapshotRow; source_time: string | null; detail_ref: string | null };
export type ReceiptSnapshot = {
  schema: "mail_receipt_snapshot.v1" | "mail_receipt_snapshot.v2";
  sync?: { checkpoint: string | null; aliases: Record<string, string>; unavailable: string[]; archive_refs: string[]; records: ReceiptSyncRecord[]; pending: { cursor: string; page: number; started_at: number; prior_partial: boolean } | null }; account_binding: string; freshness: string;
  coverage: { partial: boolean; truncated: boolean; source_count: number; window_from: string | null; window_to: string | null; source: "gmail_live" | "legacy_pkm" };
  rows: SnapshotRow[];
};
const DECIMAL = /^\d{1,12}(?:\.\d{1,2})?$/;
const REF = /^[a-f0-9]{48,64}$/;
const CATEGORIES = ["Shopping", "Food", "Travel", "Transport", "Software & Subscriptions", "Cloud & Infra", "Bills", "Uncategorized", "Subscription", "Other"];
const STATUSES = ["paid", "overdue", "refunded", "cancelled", "trial", "delivered", "payment_failed", "suspended", "renewal_due"];
const DOCS = ["invoice", "receipt", "payment_confirmation", "order_confirmation", "booking", "fulfillment"];
const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\r\n\x00-\x1f]|https?:|www\.|@/i.test(v);
const date = (v: unknown) => v === null || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v.slice(0, 10)).toISOString().slice(0, 10) === v.slice(0, 10));
// Document dates are verbatim evidence from the reviewed extraction contract.
// Preserve the displayed value; never infer a year or change canonical grouping.
const documentDate = (v: unknown) => v === null || text(v, 64);
const oneOf = (v: unknown, values: readonly string[]) => typeof v === "string" && values.includes(v);
const member = (v: unknown, values: readonly string[]) => v === null || (typeof v === "string" && values.includes(v));
function record(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k)) || keys.some(k => !(k in v))) throw new DurableResourceError("schema_invalid", "schema", "Invalid receipt snapshot shape.");
}
function identifiers(v: unknown): boolean {
  return Array.isArray(v) && v.length <= 30 && v.every(i => {
    record(i, ["kind", "value"]);
    return oneOf(i.kind, ["order", "invoice", "receipt", "pnr", "payment"]) && text(i.value, 100);
  });
}
/** Reject unknown nested fields, even in authenticated old envelopes. Never spread a live DTO. */
export function validateReceiptSnapshot(v: unknown): ReceiptSnapshot {
  if (new TextEncoder().encode(JSON.stringify(v)).length > RECEIPT_SNAPSHOT_MAX_BYTES) throw new DurableResourceError("capacity_exceeded", "schema", "Receipt snapshot exceeds device capacity. Existing saved receipts were kept.");
  const v2 = Boolean(v && typeof v === "object" && (v as Record<string, unknown>).schema === "mail_receipt_snapshot.v2");
  record(v, ["schema", "account_binding", "freshness", "coverage", "rows", ...(v2 ? ["sync"] : [])]);
  const normalizedRefs = new Set<string>();
  if (v2) {
    record(v.sync, ["checkpoint", "aliases", "unavailable", "archive_refs", "records", "pending"]);
    const sync = v.sync;
    if (!Array.isArray(sync.records) || sync.records.length > 10000) throw new DurableResourceError("schema_invalid", "schema", "Invalid receipt events.");
    for (const event of sync.records) {
      record(event, ["row", "source_time", "detail_ref"]);
      if (!date(event.source_time) || (event.detail_ref !== null && (typeof event.detail_ref !== "string" || !REF.test(event.detail_ref)))) throw new DurableResourceError("schema_invalid", "schema", "Invalid receipt event chronology.");
      const nested = validateReceiptSnapshot({ schema: "mail_receipt_snapshot.v1", account_binding: v.account_binding, freshness: v.freshness, coverage: v.coverage, rows: [event.row] });
      if (nested.rows[0]?.events.length !== 1 || normalizedRefs.has(nested.rows[0]?.events[0]?.ref ?? "")) throw new DurableResourceError("schema_invalid", "schema", "Expected one normalized receipt event.");
      normalizedRefs.add(nested.rows[0]!.events[0]!.ref);
    }
    if (sync.pending !== null) {
      record(sync.pending, ["cursor", "page", "started_at", "prior_partial"]);
      if (typeof sync.pending.prior_partial !== "boolean" || typeof sync.pending.cursor !== "string" || sync.pending.cursor.length > 8192 || !Number.isInteger(sync.pending.page) || Number(sync.pending.page) < 1 || Number(sync.pending.page) > 50 || !Number.isFinite(sync.pending.started_at)) throw new DurableResourceError("schema_invalid", "schema", "Invalid receipt continuation.");
    }
    if ((sync.checkpoint !== null && (typeof sync.checkpoint !== "string" || !/^grc1_[A-Za-z0-9_-]{39,8100}$/.test(sync.checkpoint))) ||
        !sync.aliases || typeof sync.aliases !== "object" || Array.isArray(sync.aliases) || Object.entries(sync.aliases).length > 10000 ||
        !Object.entries(sync.aliases).every(([key, value]) => REF.test(key) && typeof value === "string" && REF.test(value)) ||
        ![sync.unavailable, sync.archive_refs].every(values => Array.isArray(values) && values.length <= 10000 && values.every(value => typeof value === "string" && REF.test(value))))
      throw new DurableResourceError("schema_invalid", "schema", "Invalid receipt continuity.");
  }
  record(v.coverage, ["partial", "truncated", "source_count", "window_from", "window_to", "source"]);
  if ((!v2 && v.schema !== "mail_receipt_snapshot.v1") || (typeof v.account_binding !== "string" || !REF.test(v.account_binding)) || !date(v.freshness) || !v.freshness ||
    typeof v.coverage.partial !== "boolean" || typeof v.coverage.truncated !== "boolean" || !Number.isSafeInteger(v.coverage.source_count) || Number(v.coverage.source_count) < 0 || Number(v.coverage.source_count) > 10000 ||
    !date(v.coverage.window_from) || !date(v.coverage.window_to) || !oneOf(v.coverage.source, ["gmail_live", "legacy_pkm"]) || !Array.isArray(v.rows) || v.rows.length > 10000) throw new DurableResourceError("schema_invalid", "schema", "Invalid receipt snapshot.");
  const rowRefs = new Set<string>(); const eventRefs = new Set<string>();
  for (const r of v.rows) {
    record(r, ["ref", "display_id", "primary_event_ref", "merchant", "category", "display_kind", "brand", "amount", "currency", "transaction_date", "identifiers", "status", "recurrence", "attention_state", "attention_reason", "attention_is_prediction", "attention_date", "document_kind", "confidence", "events"]);
    if ((typeof r.ref !== "string" || !REF.test(r.ref)) || rowRefs.has(String(r.ref)) || typeof r.display_id !== "string" || !/^group-[a-z0-9]{1,64}$/.test(r.display_id) || !text(r.merchant, 100) || !member(r.category, CATEGORIES) || !oneOf(r.display_kind, ["merchant", "category", "generic"]) || (r.brand !== null && !isVerifiedReceiptMerchantKey(r.brand)) ||
      (r.amount !== null && (typeof r.amount !== "string" || !DECIMAL.test(r.amount))) || !member(r.currency, ["USD", "INR", "EUR", "GBP", "$"]) || !documentDate(r.transaction_date) || !documentDate(r.attention_date) || !identifiers(r.identifiers) || !member(r.status, STATUSES) || !oneOf(r.recurrence, ["recurring", "one_time", "unknown"]) ||
      !oneOf(r.attention_state, ["none", "needs_attention", "coming_up", "needs_review"]) || !member(r.attention_reason, ["overdue", "payment_failed", "suspended", "renewal_due", "low_confidence"]) || typeof r.attention_is_prediction !== "boolean" || !member(r.document_kind, DOCS) ||
      (r.confidence !== null && (typeof r.confidence !== "number" || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1)) || !Array.isArray(r.events) || !r.events.length || r.events.length > 300) throw new DurableResourceError("schema_invalid", "schema", "Invalid canonical receipt.");
    rowRefs.add(String(r.ref));
    for (const e of r.events) {
      record(e, ["ref", "locator", "document_kind", "status", "kind", "date", "amount", "currency"]);
      if ((typeof e.ref !== "string" || !REF.test(e.ref)) || eventRefs.has(v2 && (v.sync as { archive_refs: string[] }).archive_refs.includes(String(r.ref)) ? `${r.ref}:${e.ref}` : String(e.ref)) || (e.locator !== null && (typeof e.locator !== "string" || !/^grs1_[A-Za-z0-9_-]{39,310}$/.test(e.locator))) || !member(e.document_kind, DOCS) || !member(e.status, STATUSES) || !oneOf(e.kind, ["purchase", "fulfillment", "refund", "cancellation", "unknown"]) || !documentDate(e.date) || (e.amount !== null && (typeof e.amount !== "string" || !DECIMAL.test(e.amount))) || !member(e.currency, ["USD", "INR", "EUR", "GBP", "$"])) throw new DurableResourceError("schema_invalid", "schema", "Invalid receipt event.");
      eventRefs.add(v2 && (v.sync as { archive_refs: string[] }).archive_refs.includes(String(r.ref)) ? `${r.ref}:${e.ref}` : String(e.ref));
    }
    if (!r.events.some(e => e.ref === r.primary_event_ref)) throw new DurableResourceError("schema_invalid", "schema", "Receipt representative is missing.");
  }
  if (v2) {
    const sync = (v as unknown as ReceiptSnapshot).sync!;
    const archives = new Set(sync.archive_refs);
    const active = new Set((v as unknown as ReceiptSnapshot).rows.filter(row => !archives.has(row.ref)).flatMap(row => row.events.map(event => event.ref)));
    if (archives.size !== sync.archive_refs.length || [...archives].some(ref => !rowRefs.has(ref)) ||
        [...active].some(ref => !normalizedRefs.has(ref)) || [...normalizedRefs].some(ref => !active.has(ref)))
      throw new DurableResourceError("schema_invalid", "schema", "Receipt continuity identities do not match.");
  }
  return v as unknown as ReceiptSnapshot;
}
export async function receiptAccountBinding(account: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`mail_receipts.v1\0${account}`));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
const decimal = (item: ReceiptListItem) => item.amount_decimal && DECIMAL.test(item.amount_decimal) ? item.amount_decimal :
  typeof item.amount === "number" && DECIMAL.test(String(item.amount)) ? String(item.amount) : null;

export async function captureReceiptSnapshot(items: readonly ReceiptListItem[], account: string, coverage: ReceiptSnapshot["coverage"], now = new Date()): Promise<ReceiptSnapshot> {
  const account_binding = await receiptAccountBinding(account);
  const refs = new Map<string, string>();
  for (const i of items) refs.set(i.source_id || i.receipt_key || String(i.id), i.event_id ?? await receiptAccountBinding(`event:${i.source_id || i.receipt_key || i.id}`));
  const rows: SnapshotRow[] = [];
  for (const row of buildRecentReceiptRows(items, account)) {
    const members = row.sourceReceiptKeys.map(key => items.find(i => (i.source_id || i.receipt_key || String(i.id)) === key)!);
    const primary = members.find(i => (i.source_id || i.receipt_key || String(i.id)) === row.primaryReceiptKey)!;
    rows.push({
      ref: await receiptAccountBinding(`group:${row.id}`), display_id: row.id, primary_event_ref: refs.get(row.primaryReceiptKey)!,
      merchant: row.merchantName, category: row.category, display_kind: row.displayKind,
      brand: row.brandKey ?? null,
      amount: decimal(primary), currency: row.currency, transaction_date: row.receiptDate,
      identifiers: row.identifiers.map(i => ({ kind: i.kind, value: i.value })), status: row.status, recurrence: row.recurrence,
      attention_state: row.attentionState, attention_reason: row.attentionReason, attention_is_prediction: row.attentionIsPrediction,
      attention_date: row.attentionDate, document_kind: row.documentKind ?? null, confidence: row.confidence,
      events: row.eventTimeline.map(timeline => { const i = members.find(member => (member.source_id || member.receipt_key || String(member.id)) === timeline.sourceReceiptKey)!; return ({ ref: refs.get(timeline.sourceReceiptKey)!,
        locator: i.durable_source_ref ?? null, document_kind: i.document_kind ?? null, status: i.status ?? null,
        kind: timeline.eventKind, date: timeline.date,
        amount: decimal(i), currency: i.currency ?? null }); }),
    });
  }
  return validateReceiptSnapshot({ schema: "mail_receipt_snapshot.v1", account_binding, freshness: now.toISOString(), coverage, rows });
}
/** Restore the already-decided groups. No new grouping, inference or provider read. */
export function receiptSnapshotRows(snapshot: ReceiptSnapshot): RecentReceiptRow[] {
  return validateReceiptSnapshot(snapshot).rows.map((r, index) => {
    const brand = resolveSavedReceiptMerchantBrand(r.brand, r.merchant);
    const secondaryText = [r.display_kind === "merchant" ? r.category === "Other" ? "Uncategorized" : r.category : r.category === "Other" || r.category === "Uncategorized" ? "Uncategorized" : null,
      receiptAttentionLabel(r.attention_state, r.attention_reason, r.attention_is_prediction) || receiptStatusLabel(r.status),
      formatLocalDateTime(r.transaction_date, { month: "short", day: "numeric" })].filter(Boolean).join(" · ");
    return { id: r.display_id, archived: snapshot.sync?.archive_refs.includes(r.ref) ?? false, sourceUnavailable: r.events.every(e => snapshot.sync?.unavailable.includes(e.ref)), primaryReceiptId: index, primaryReceiptKey: r.primary_event_ref,
      merchantName: r.merchant, category: r.category, displayKind: r.display_kind, brandKey: brand?.merchantId ?? null, logoDomain: brand?.logoDomain ?? null,
      amount: r.amount === null ? null : Number(r.amount), currency: r.currency,
      searchText: [r.merchant, r.category, r.status, r.recurrence, r.document_kind, r.attention_state, r.attention_reason, ...r.events.flatMap(e => [e.status, e.document_kind]), ...r.identifiers.map(i => i.value)].filter(Boolean).join(" "),
      secondaryText: r.events.every(e => snapshot.sync?.unavailable.includes(e.ref)) ? "Source unavailable · " + secondaryText : secondaryText, secondaryDetail: r.display_kind === "merchant" && r.category !== "Other" && r.category !== "Uncategorized" ? r.category : null,
      secondaryMeta: secondaryText, sourceReceiptIds: r.events.map((_, j) => j), sourceReceiptKeys: r.events.map(e => e.ref), identifiers: r.identifiers,
      status: r.status, recurrence: r.recurrence, attentionState: r.attention_state, attentionReason: r.attention_reason,
      attentionIsPrediction: r.attention_is_prediction, attentionDate: r.attention_date, documentKind: r.document_kind,
      receiptDate: r.transaction_date, confidence: r.confidence,
      eventTimeline: r.events.map(e => ({ sourceReceiptKey: e.ref, sourceUnavailable: snapshot.sync?.unavailable.includes(e.ref) ?? false, documentKind: e.document_kind, eventKind: e.kind,
        status: e.status, attentionState: "none", date: e.date, merchantName: r.merchant, subject: null, detail: receiptDocumentLabel(e.document_kind) })),
    };
  });
}
