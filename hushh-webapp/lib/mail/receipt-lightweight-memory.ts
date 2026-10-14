import { RECEIPT_MEMORY_MAX_BYTES, type ReceiptSnapshot } from "./receipt-snapshot";
import { paidReceiptMoney } from "./receipt-analysis";

export type LightweightReceiptMemory = {
  schema_version: 2;
  readable_summary: { text: string; highlights: string[]; updated_at: string; source_label: "Mail receipts" };
  observed_facts: { merchant_affinity: { merchant_label: string; purchase_count: number }[];
    category_affinity: { category: string; purchase_count: number }[];
    purchase_patterns: { merchant_label: string; recurring_count: number }[] };
  inferred_preferences: { preference_signals: string[] };
  confidence: number | null;
  coverage: { canonical_count: number; partial: boolean; truncated: boolean };
  provenance: { source_kind: "mail_receipt_snapshot"; updated_at: string };
};
const safe = (s: string) => s.trim().length > 0 && s.length <= 100 && !/[\r\n\x00-\x1f]|https?:|www\.|@/i.test(s);
export function safeAffinityLabel(value: unknown): value is string {
  if (typeof value !== "string" || !safe(value)) return false;
  try { assertLightweightReceiptFacts([value]); return true; } catch { return false; }
}
export function lightweightReceiptMemory(snapshot: ReceiptSnapshot): LightweightReceiptMemory {
  const merchants = new Map<string, number>(), categories = new Map<string, number>(), recurring = new Map<string, number>();
  for (const row of snapshot.rows) {
    if (!paidReceiptMoney(row)) continue;
    if (row.display_kind === "merchant" && safeAffinityLabel(row.merchant)) merchants.set(row.merchant, (merchants.get(row.merchant) ?? 0) + 1);
    if (row.category) categories.set(row.category, (categories.get(row.category) ?? 0) + 1);
    if (row.recurrence === "recurring" && safeAffinityLabel(row.merchant)) recurring.set(row.merchant, (recurring.get(row.merchant) ?? 0) + 1);
  }
  const ranked = (values: Map<string, number>) => [...values].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20);
  const confidences = snapshot.rows.flatMap(r => r.confidence === null ? [] : [r.confidence]);
  const value: LightweightReceiptMemory = {
    schema_version: 2,
    readable_summary: { text: `${snapshot.rows.length} canonical receipts inform this observed shopping sample. ${snapshot.coverage.partial ? "Coverage is partial." : "This is a completed scan, not all purchases."}`,
      highlights: ranked(merchants).slice(0, 3).map(([merchant, count]) => `${merchant}: ${count} purchases in the observed sample`),
      updated_at: snapshot.freshness, source_label: "Mail receipts" },
    observed_facts: { merchant_affinity: ranked(merchants).map(([merchant_label, purchase_count]) => ({ merchant_label, purchase_count })),
      category_affinity: ranked(categories).map(([category, purchase_count]) => ({ category, purchase_count })),
      purchase_patterns: ranked(recurring).map(([merchant_label, recurring_count]) => ({ merchant_label, recurring_count })) },
    // Receipts alone establish counts/patterns, not durable preferences. Do
    // not infer products, price preferences or cadence from short_detail.
    inferred_preferences: { preference_signals: [] },
    confidence: confidences.length ? Math.min(...confidences) : null,
    coverage: { canonical_count: snapshot.rows.length, partial: snapshot.coverage.partial, truncated: snapshot.coverage.truncated },
    provenance: { source_kind: "mail_receipt_snapshot", updated_at: snapshot.freshness },
  };
  assertReceiptMemoryBudget(value);
  return value;
}
export function assertReceiptMemoryBudget(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).length > RECEIPT_MEMORY_MAX_BYTES)
    throw new Error("Receipt memory exceeds the 16 KiB UTF-8 budget. Existing memory was kept.");
}
/** Receipt-owned Soul facts must remain summaries of aggregate evidence. */
export function assertLightweightReceiptFacts(facts: unknown): void {
  assertReceiptMemoryBudget(facts);
  const text = JSON.stringify(facts);
  const naturalDate = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/i;
  const transactionId = /\b(?:order|invoice|receipt|pnr)\s+[#:]?[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b/i;
  if (naturalDate.test(text) || transactionId.test(text)) throw new Error("Receipt memory contains transaction details. Existing memory was kept.");
  if (/(?:https?:|www\.|mailto:|@|gmail_live_|grs1_|_canonical_index|gmail_message_id|source_evidence)|\b(?:USD|INR|EUR|GBP|AUD|JPY|CAD)\s*\d|[$€£₹¥]\s*\d|\d\s*(?:dollars|euros|rupees)\b|\b(?:paid|total|amount)\s*\d|\b\d{4}-\d{2}-\d{2}(?:T|\b)|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\bPNR\s+\S+|\b(?:order|invoice|pnr|receipt)\s*(?:id|number|reference|#|:)\s*\S+/i.test(text))
    throw new Error("Receipt memory contains transaction details. Existing memory was kept.");
}

export function safeReceiptPreference(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 200 || /[\d\r\n]/.test(value) || !/\b(?:prefers?|preference|likes?|avoids?)\b/i.test(value)) return false;
  try { assertLightweightReceiptFacts([value]); return true; } catch { return false; }
}

/** Routine Chat compatibility projects legacy branches instead of traversing
 * their summaries/highlights or rows. No durable migration occurs on a read. */
export function receiptMemoryForChat(value: unknown): Record<string, unknown> {
  const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const memory = record(value), observed = record(memory.observed_facts);
  const labels = (v: unknown, key: string, countKey: string) => (Array.isArray(v) ? v : []).slice(0, 20).flatMap(item => {
    const row = record(item), label = row[key], count = row[countKey] ?? (countKey === "purchase_count" ? row.receipt_count_365d : undefined);
    return safeAffinityLabel(label) && typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= 10000 ? [{ [key]: label, [countKey]: count }] : [];
  });
  const result = {
    readable_summary: "Saved Mail receipt affinities describe an observed sample; exact analysis requires receipt functions.",
    merchant_affinity: labels(observed.merchant_affinity, "merchant_label", "purchase_count"),
    category_affinity: labels(observed.category_affinity, "category", "purchase_count"),
    recurring_patterns: labels(observed.purchase_patterns, "merchant_label", "recurring_count"),
    preferences: (Array.isArray(record(memory.inferred_preferences).preference_signals) ? record(memory.inferred_preferences).preference_signals as unknown[] : []).map(v => typeof v === "string" ? v : record(v).label).filter(safeReceiptPreference).slice(0, 20),
  };
  const arrays = [result.recurring_patterns, result.merchant_affinity, result.category_affinity, result.preferences];
  while (new TextEncoder().encode(JSON.stringify(result)).length > RECEIPT_MEMORY_MAX_BYTES) {
    const longest = arrays.reduce((a, b) => JSON.stringify(a).length >= JSON.stringify(b).length ? a : b);
    if (!longest.length) break;
    longest.pop();
  }
  assertReceiptMemoryBudget(result);
  return result;
}
