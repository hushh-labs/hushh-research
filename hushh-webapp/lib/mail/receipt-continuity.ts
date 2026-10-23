import { receiptGroupingDetail } from "@/lib/profile/gmail-receipt-presentation";
import { resolveSavedReceiptMerchantBrand } from "./receipt-merchant-registry";
import { captureReceiptSnapshot, receiptAccountBinding, validateReceiptSnapshot, type ReceiptSnapshot, type ReceiptSyncRecord } from "./receipt-snapshot";
import type { GmailLiveReceiptScanResponse, ReceiptListItem } from "@/lib/services/gmail-receipts-service";

/** Only v2's closed event facts may re-enter the existing grouping projection.
 * V1 display groups are never reverse-engineered into provider records. */
function normalizedInput(record: ReceiptSyncRecord, index: number): ReceiptListItem {
  const row = record.row, event = row.events[0]!;
  const brand = resolveSavedReceiptMerchantBrand(row.brand, row.merchant);
  return { id: index, source_id: event.ref, event_id: event.ref, receipt_key: event.ref, gmail_message_id: "", source_kind: "gmail_device",
    merchant_name: row.display_kind === "merchant" ? row.merchant : null, merchant_domain: brand?.logoDomain ?? null,
    category: row.category, category_confidence: row.category ? 1 : null, classification_confidence: row.confidence ?? undefined,
    status: row.status, recurrence: row.recurrence, attention_state: row.attention_state, attention_reason: row.attention_reason,
    attention_is_prediction: row.attention_is_prediction, attention_date: row.attention_date, transaction_date: row.transaction_date,
    gmail_internal_date: record.source_time, identifiers: row.identifiers, document_kind: row.document_kind,
    amount: event.amount === null ? null : Number(event.amount), amount_decimal: event.amount, currency: event.currency,
    event_type: event.kind, durable_source_ref: event.locator ?? undefined, grouping_detail_ref: record.detail_ref ?? undefined };
}

/** Reconcile exact event identity, then reuse the canonical grouping owner. */
export async function mergeReceiptSnapshot(previous: ReceiptSnapshot | null, items: readonly ReceiptListItem[], account: string,
  response: GmailLiveReceiptScanResponse, unavailable: readonly string[], complete: boolean,
  pending: NonNullable<ReceiptSnapshot["sync"]>["pending"] = null): Promise<ReceiptSnapshot> {
  const priorPartial = previous?.sync?.pending?.prior_partial ?? previous?.coverage.partial ?? false;
  const coverage = { partial: !complete || priorPartial, truncated: response.coverage.reached_limit,
    source_count: items.length, window_from: previous?.coverage.window_from ?? response.coverage.window_start ?? null,
    window_to: response.coverage.window_end ?? previous?.coverage.window_to ?? null, source: "gmail_live" as const };
  const aliases: Record<string, string> = { ...previous?.sync?.aliases };
  const records = new Map((previous?.sync?.records ?? []).map(record => [record.row.events[0]!.ref, record]));
  for (const item of items) {
    const originalRef = await receiptAccountBinding(`event:${item.source_id || item.receipt_key || item.id}`);
    const ref = item.event_id ?? originalRef;
    aliases[originalRef] = ref;
    const eventSnapshot = await captureReceiptSnapshot([{ ...item, event_id: ref }], account, coverage);
    const detail = receiptGroupingDetail(item);
    const sourceTime = item.gmail_internal_date;
    records.set(ref, { row: eventSnapshot.rows[0]!,
      source_time: sourceTime && Number.isFinite(Date.parse(sourceTime)) ? new Date(sourceTime).toISOString() : null,
      detail_ref: detail ? await receiptAccountBinding(`detail:${detail}`) : null });
  }
  const canonical = (ref: string) => aliases[ref] ?? ref;
  const previousRows = (previous?.rows ?? []).map(row => ({ ...row, primary_event_ref: canonical(row.primary_event_ref),
    events: row.events.map(event => ({ ...event, ref: canonical(event.ref) })) }));
  const incoming = await captureReceiptSnapshot([...records.values()].map(normalizedInput), account, coverage);
  const archive = previousRows.filter(row => row.events.some(event => !records.has(event.ref)));
  // Preserve a group's UI identity as additional events arrive or its
  // representative improves; the normalized grouping result owns all facts.
  const used = new Set<string>();
  const rows = incoming.rows.map(row => {
    const refs = new Set(row.events.map(event => event.ref));
    const prior = previousRows.find(old => !used.has(old.ref) && old.events.every(event => records.has(event.ref)) && old.events.some(event => refs.has(event.ref)));
    if (!prior) return row;
    used.add(prior.ref); return { ...row, ref: prior.ref, display_id: prior.display_id };
  });
  for (const old of archive) {
    if (rows.some(row => row.ref === old.ref || row.display_id === old.display_id)) {
      const ref = await receiptAccountBinding(`archive:${old.ref}`);
      rows.push({ ...old, ref, display_id: `group-${ref.slice(0, 20)}` });
    } else rows.push(old);
  }
  const missing = new Set(previous?.sync?.unavailable ?? []);
  const knownRefs = new Set(rows.flatMap(row => row.events.map(event => event.ref)));
  unavailable.forEach(ref => { if (knownRefs.has(ref)) missing.add(ref); });
  items.forEach(item => { if (item.event_id) missing.delete(item.event_id); });
  const archiveRefs = rows.filter(row => row.events.some(event => !records.has(event.ref))).map(row => row.ref);
  return validateReceiptSnapshot({ ...incoming, schema: "mail_receipt_snapshot.v2", rows,
    freshness: complete ? incoming.freshness : previous?.freshness ?? incoming.freshness,
    coverage: { ...coverage, source_count: new Set([...records.keys(), ...archive.flatMap(row => row.events.map(event => event.ref))]).size,
      partial: !complete || priorPartial || archive.length > 0,
      truncated: response.coverage.reached_limit || Boolean(previous?.coverage.truncated) },
    sync: { checkpoint: complete ? response.checkpoint ?? null : previous?.sync?.checkpoint ?? null,
      aliases, unavailable: [...missing], archive_refs: archiveRefs, records: [...records.values()], pending } });
}
