/**
 * Recurring bills the owner tracks, and the choices made on spending insights.
 *
 * Tracking records what the owner decided about their own receipts. It never
 * moves money and never talks to a bank. It is encrypted with the vault key,
 * stored on the device next to the saved receipts, and bound to the owner and
 * the connected mailbox, so another account's choices can never show here.
 */
import { DurableResourceError } from "@/lib/services/durable-resource-error";
import { SecureDurableResourceService, type DurableVersion } from "@/lib/services/secure-durable-resource-service";

import { type Cadence, isoDate, nextCycle, rollForward } from "./receipt-cadence";
import { receiptStoreGuard, type ReceiptStoreSession } from "./receipt-store";
import { receiptAccountBinding } from "./receipt-snapshot";

export const TRACKING_PREFIX = "mail_receipt_tracking.v1:";
const MAX = { bills: 60, events: 200, reviews: 60, dismissed: 200, hidden: 200, skipped: 24, evidence: 12, history: 24, bytes: 256 * 1024 };

export interface TrackedBill {
  id: string;
  /** Dedupes a detected pattern; a manual bill has its own key. */
  patternKey: string;
  source: "detected" | "manual";
  name: string;
  icon: string;
  kind: "fixed" | "variable";
  currency: string;
  frequency: Cadence;
  agreedMinor: number | null;
  anchorDay: number;
  /** Next known or estimated date, as stored when the bill was tracked or its date changed. */
  nextOn: string | null;
  nextOnSource: "estimated" | "yours";
  /** Occurrence dates the owner skipped. */
  skippedOn: string[];
  reason: string;
  evidence: Array<{ ref: string; label: string; amountMinor: number | null; on: string | null }>;
  history: Array<{ paidOn: string; amountMinor: number; ref: string }>;
  status: "tracking" | "stopped";
  createdAt: string;
}

export type TrackingEventKind =
  | "bill_added" | "date_changed" | "occurrence_skipped" | "tracking_stopped" | "tracking_resumed"
  | "pattern_hidden" | "review_saved" | "cancellation_confirmed" | "insight_reviewed";

export interface TrackingEvent {
  id: string;
  at: string;
  kind: TrackingEventKind;
  billId: string | null;
  /** Names and dates only; the screen composes the sentence. */
  detail: Record<string, string | number | null>;
}

export interface PlanChoice { key: string; label: string; monthlyMinor: number | null; currency: string }

export interface PlanReview {
  insightId: string;
  reason: string;
  plans: PlanChoice[];
  choices: Record<string, "keep" | "cancel">;
  requestedAt: string;
  /** plan key → the provider's own cancellation receipt that confirmed it. */
  confirmed: Record<string, { evidenceRef: string; at: string }>;
}

export interface ReceiptTrackingDoc {
  schema: "mail_receipt_tracking.v1";
  account_binding: string;
  bills: TrackedBill[];
  events: TrackingEvent[];
  reviews: PlanReview[];
  /** Insights the owner looked at and marked as not an issue. */
  dismissed: Array<{ id: string; title: string; at: string }>;
  /** Detected patterns the owner said are not recurring bills. */
  hiddenPatterns: string[];
}

export function emptyTrackingDoc(accountBinding: string): ReceiptTrackingDoc {
  return { schema: "mail_receipt_tracking.v1", account_binding: accountBinding, bills: [], events: [], reviews: [], dismissed: [], hiddenPatterns: [] };
}

// ---- validation -------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const bad = (): never => { throw new DurableResourceError("schema_invalid", "schema", "Saved tracking choices have an unexpected shape."); };
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === "string" && v.length <= max ? v : bad());
const iso = (v: unknown): string | null => (v === null ? null : typeof v === "string" && ISO.test(v) ? v : bad());
const int = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1e12 ? v : bad());
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) && v.length <= max ? v : bad());
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T => (typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : bad());

/** Strict on purpose: unknown fields or shapes are refused instead of trusted. */
export function validateTrackingDoc(value: unknown): ReceiptTrackingDoc {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX.bytes) throw new DurableResourceError("capacity_exceeded", "schema", "Saved tracking choices are too large.");
  if (!isObj(value) || value.schema !== "mail_receipt_tracking.v1") return bad();
  const bills = arr(value.bills, MAX.bills).map((raw): TrackedBill => {
    if (!isObj(raw)) return bad();
    return {
      id: str(raw.id, 80), patternKey: str(raw.patternKey, 200), source: oneOf(raw.source, ["detected", "manual"]),
      name: str(raw.name, 80), icon: str(raw.icon, 24), kind: oneOf(raw.kind, ["fixed", "variable"]), currency: str(raw.currency, 3),
      frequency: oneOf(raw.frequency, ["weekly", "monthly", "quarterly", "yearly"]), agreedMinor: raw.agreedMinor === null ? null : int(raw.agreedMinor),
      anchorDay: int(raw.anchorDay), nextOn: iso(raw.nextOn), nextOnSource: oneOf(raw.nextOnSource, ["estimated", "yours"]),
      skippedOn: arr(raw.skippedOn, MAX.skipped).map((d) => iso(d) ?? bad()), reason: str(raw.reason, 240),
      evidence: arr(raw.evidence, MAX.evidence).map((e) => isObj(e) ? { ref: str(e.ref, 200), label: str(e.label, 120), amountMinor: e.amountMinor === null ? null : int(e.amountMinor), on: iso(e.on) } : bad()),
      history: arr(raw.history, MAX.history).map((h) => isObj(h) ? { paidOn: iso(h.paidOn) ?? bad(), amountMinor: int(h.amountMinor), ref: str(h.ref, 200) } : bad()),
      status: oneOf(raw.status, ["tracking", "stopped"]), createdAt: str(raw.createdAt, 40),
    };
  });
  const events = arr(value.events, MAX.events).map((raw): TrackingEvent => {
    if (!isObj(raw) || !isObj(raw.detail)) return bad();
    const detail: Record<string, string | number | null> = {};
    for (const [key, item] of Object.entries(raw.detail)) detail[str(key, 40)] = item === null ? null : typeof item === "number" ? item : str(item, 240);
    return {
      id: str(raw.id, 80), at: str(raw.at, 40), billId: raw.billId === null ? null : str(raw.billId, 80), detail,
      kind: oneOf(raw.kind, ["bill_added", "date_changed", "occurrence_skipped", "tracking_stopped", "tracking_resumed", "pattern_hidden", "review_saved", "cancellation_confirmed", "insight_reviewed"]),
    };
  });
  const reviews = arr(value.reviews, MAX.reviews).map((raw): PlanReview => {
    if (!isObj(raw) || !isObj(raw.choices) || !isObj(raw.confirmed)) return bad();
    return {
      insightId: str(raw.insightId, 200), reason: str(raw.reason, 240), requestedAt: str(raw.requestedAt, 40),
      plans: arr(raw.plans, 24).map((p) => isObj(p) ? { key: str(p.key, 200), label: str(p.label, 80), monthlyMinor: p.monthlyMinor === null ? null : int(p.monthlyMinor), currency: str(p.currency, 3) } : bad()),
      choices: Object.fromEntries(Object.entries(raw.choices).map(([k, v]) => [str(k, 200), oneOf(v, ["keep", "cancel"])])),
      confirmed: Object.fromEntries(Object.entries(raw.confirmed).map(([k, v]) => isObj(v) ? [str(k, 200), { evidenceRef: str(v.evidenceRef, 200), at: str(v.at, 40) }] : bad())),
    };
  });
  return {
    schema: "mail_receipt_tracking.v1", account_binding: str(value.account_binding, 64), bills, events, reviews,
    dismissed: arr(value.dismissed, MAX.dismissed).map((d) => isObj(d) ? { id: str(d.id, 200), title: str(d.title, 120), at: str(d.at, 40) } : bad()),
    hiddenPatterns: arr(value.hiddenPatterns, MAX.hidden).map((p) => str(p, 200)),
  };
}

// ---- pure changes -------------------------------------------------------------

export interface Ctx { now: Date; id: () => string }

function withEvent(doc: ReceiptTrackingDoc, kind: TrackingEventKind, billId: string | null, detail: TrackingEvent["detail"], ctx: Ctx): ReceiptTrackingDoc {
  const event: TrackingEvent = { id: ctx.id(), at: ctx.now.toISOString(), kind, billId, detail };
  return { ...doc, events: [event, ...doc.events].slice(0, MAX.events) };
}

export interface NewBill {
  patternKey: string;
  source: TrackedBill["source"];
  name: string;
  icon: string;
  kind: TrackedBill["kind"];
  currency: string;
  frequency: Cadence;
  agreedMinor: number | null;
  anchorDay: number;
  nextOn: string | null;
  reason: string;
  evidence: TrackedBill["evidence"];
  history: TrackedBill["history"];
}

/** Track a bill. A pattern already tracked changes nothing; a stopped one resumes. */
export function trackBill(doc: ReceiptTrackingDoc, input: NewBill, ctx: Ctx): ReceiptTrackingDoc {
  const existing = doc.bills.find((bill) => bill.patternKey === input.patternKey);
  if (existing) return existing.status === "stopped" ? resumeTracking(doc, existing.id, ctx) : doc;
  if (doc.bills.length >= MAX.bills) throw new DurableResourceError("capacity_exceeded", "schema", "You are tracking the most bills allowed.");
  const bill: TrackedBill = {
    ...input, id: `bill_${ctx.id()}`, skippedOn: [], nextOnSource: input.source === "manual" ? "yours" : "estimated",
    evidence: input.evidence.slice(0, MAX.evidence), history: input.history.slice(-MAX.history), status: "tracking", createdAt: ctx.now.toISOString(),
  };
  return withEvent({ ...doc, bills: [...doc.bills, bill], hiddenPatterns: doc.hiddenPatterns.filter((key) => key !== input.patternKey) }, "bill_added", bill.id, { name: bill.name, source: bill.source }, ctx);
}

function updateBill(doc: ReceiptTrackingDoc, id: string, change: (bill: TrackedBill) => TrackedBill): ReceiptTrackingDoc {
  return { ...doc, bills: doc.bills.map((bill) => (bill.id === id ? change(bill) : bill)) };
}

export function changeNextDate(doc: ReceiptTrackingDoc, id: string, from: string | null, to: string, ctx: Ctx): ReceiptTrackingDoc {
  const bill = doc.bills.find((item) => item.id === id);
  if (!bill || bill.status !== "tracking" || !ISO.test(to)) return doc;
  const next = updateBill(doc, id, (item) => ({ ...item, nextOn: to, nextOnSource: "yours", anchorDay: Number(to.slice(8, 10)), skippedOn: item.skippedOn.filter((date) => date >= to) }));
  return withEvent(next, "date_changed", id, { name: bill.name, from, to }, ctx);
}

/** Skip one occurrence: that date is passed over and the next cycle becomes next. */
export function skipOccurrence(doc: ReceiptTrackingDoc, id: string, occurrenceOn: string, ctx: Ctx): ReceiptTrackingDoc {
  const bill = doc.bills.find((item) => item.id === id);
  if (!bill || bill.status !== "tracking" || bill.skippedOn.includes(occurrenceOn)) return doc;
  const next = updateBill(doc, id, (item) => ({ ...item, skippedOn: [...item.skippedOn, occurrenceOn].slice(-MAX.skipped) }));
  return withEvent(next, "occurrence_skipped", id, { name: bill.name, on: occurrenceOn }, ctx);
}

export function stopTracking(doc: ReceiptTrackingDoc, id: string, ctx: Ctx): ReceiptTrackingDoc {
  const bill = doc.bills.find((item) => item.id === id);
  if (!bill || bill.status === "stopped") return doc;
  return withEvent(updateBill(doc, id, (item) => ({ ...item, status: "stopped" })), "tracking_stopped", id, { name: bill.name }, ctx);
}

export function resumeTracking(doc: ReceiptTrackingDoc, id: string, ctx: Ctx): ReceiptTrackingDoc {
  const bill = doc.bills.find((item) => item.id === id);
  if (!bill || bill.status === "tracking") return doc;
  return withEvent(updateBill(doc, id, (item) => ({ ...item, status: "tracking" })), "tracking_resumed", id, { name: bill.name }, ctx);
}

export function hidePattern(doc: ReceiptTrackingDoc, patternKey: string, name: string, ctx: Ctx): ReceiptTrackingDoc {
  if (doc.hiddenPatterns.includes(patternKey)) return doc;
  return withEvent({ ...doc, hiddenPatterns: [...doc.hiddenPatterns, patternKey].slice(-MAX.hidden) }, "pattern_hidden", null, { name }, ctx);
}

export function recordInsightReviewed(doc: ReceiptTrackingDoc, id: string, title: string, ctx: Ctx): ReceiptTrackingDoc {
  if (doc.dismissed.some((item) => item.id === id)) return doc;
  const next = { ...doc, dismissed: [...doc.dismissed, { id, title: title.slice(0, 120), at: ctx.now.toISOString() }].slice(-MAX.dismissed) };
  return withEvent(next, "insight_reviewed", null, { title: title.slice(0, 120) }, ctx);
}

export function savePlanReview(doc: ReceiptTrackingDoc, review: Pick<PlanReview, "insightId" | "reason" | "plans" | "choices">, ctx: Ctx): ReceiptTrackingDoc {
  const previous = doc.reviews.find((item) => item.insightId === review.insightId);
  // A cancellation the provider already confirmed stays confirmed; changing back to keep clears it.
  const confirmed = Object.fromEntries(Object.entries(previous?.confirmed ?? {}).filter(([key]) => review.choices[key] === "cancel"));
  const saved: PlanReview = { ...review, requestedAt: previous?.requestedAt ?? ctx.now.toISOString(), confirmed };
  const reviews = [...doc.reviews.filter((item) => item.insightId !== review.insightId), saved].slice(-MAX.reviews);
  const cancelled = Object.values(review.choices).filter((choice) => choice === "cancel").length;
  return withEvent({ ...doc, reviews }, "review_saved", null, { cancel: cancelled, keep: Object.keys(review.choices).length - cancelled }, ctx);
}

/** Record the provider's own cancellation receipt. Savings count from here, never from the choice alone. */
export function confirmCancellation(doc: ReceiptTrackingDoc, insightId: string, planKey: string, evidenceRef: string, ctx: Ctx): ReceiptTrackingDoc {
  const review = doc.reviews.find((item) => item.insightId === insightId);
  if (!review || review.choices[planKey] !== "cancel" || review.confirmed[planKey]) return doc;
  const label = review.plans.find((plan) => plan.key === planKey)?.label ?? "A plan";
  const next = { ...doc, reviews: doc.reviews.map((item) => item === review ? { ...item, confirmed: { ...item.confirmed, [planKey]: { evidenceRef, at: ctx.now.toISOString() } } } : item) };
  return withEvent(next, "cancellation_confirmed", null, { name: label }, ctx);
}

export function pendingCancellations(doc: ReceiptTrackingDoc): Array<{ insightId: string; plan: PlanChoice; requestedAt: string }> {
  return doc.reviews.flatMap((review) => review.plans
    .filter((plan) => review.choices[plan.key] === "cancel" && !review.confirmed[plan.key])
    .map((plan) => ({ insightId: review.insightId, plan, requestedAt: review.requestedAt })));
}

/** Monthly savings per currency, from provider-confirmed cancellations only. */
export function confirmedSavings(doc: ReceiptTrackingDoc): Record<string, number> {
  const savings: Record<string, number> = {};
  for (const review of doc.reviews) {
    for (const plan of review.plans) {
      if (review.choices[plan.key] !== "cancel" || !review.confirmed[plan.key] || !plan.monthlyMinor) continue;
      savings[plan.currency] = (savings[plan.currency] ?? 0) + plan.monthlyMinor;
    }
  }
  return savings;
}

/** The date to show: the owner's own date while it still lies ahead, otherwise the estimate. Skipped dates are passed over. */
export function nextDateFor(bill: TrackedBill, estimatedOn: string | null, today: Date): { on: string | null; basis: "estimated" | "yours" } {
  const floor = isoDate(today);
  let basis: "estimated" | "yours" = "estimated";
  let on: string | null;
  if (bill.nextOnSource === "yours" && bill.nextOn && bill.nextOn >= floor) { on = bill.nextOn; basis = "yours"; }
  else if (estimatedOn) on = estimatedOn;
  else on = bill.nextOn ? rollForward(bill.nextOn, bill.frequency, bill.anchorDay, today) : null;
  for (let guard = 0; on && bill.skippedOn.includes(on) && guard < MAX.skipped + 1; guard += 1) on = nextCycle(on, bill.frequency, bill.anchorDay);
  return { on, basis };
}

// ---- encrypted device persistence ----------------------------------------------

export interface LoadedTracking { doc: ReceiptTrackingDoc; version: DurableVersion }

async function resourceKey(account: string): Promise<{ key: string; binding: string }> {
  const binding = await receiptAccountBinding(`tracking\0${account}`);
  return { key: TRACKING_PREFIX + binding, binding };
}

export async function loadTracking(session: ReceiptStoreSession, account: string): Promise<LoadedTracking> {
  const isCurrent = receiptStoreGuard(session);
  if (!isCurrent()) throw new DurableResourceError("authority_changed", "authority", "Unlock your vault to see tracked bills.");
  const { key, binding } = await resourceKey(account);
  const stored = await SecureDurableResourceService.read<unknown>(session.userId, key, session.vaultKey, isCurrent);
  if (!stored) return { doc: emptyTrackingDoc(binding), version: await SecureDurableResourceService.version(session.userId, key) };
  const doc = validateTrackingDoc(stored.value);
  // The stored mailbox binding must be this mailbox's; anything else is another account's data.
  if (doc.account_binding !== binding) throw new DurableResourceError("binding_invalid", "readback", "Saved tracking choices belong to another mailbox.");
  return { doc, version: { generation: stored.generation, revision: stored.revision } };
}

export async function saveTracking(session: ReceiptStoreSession, account: string, doc: ReceiptTrackingDoc, expected: DurableVersion): Promise<DurableVersion> {
  const isCurrent = receiptStoreGuard(session);
  if (!isCurrent()) throw new DurableResourceError("authority_changed", "authority", "Unlock your vault to save your choices.");
  const { key, binding } = await resourceKey(account);
  if (doc.account_binding !== binding) throw new DurableResourceError("binding_invalid", "schema", "Tracking choices belong to another mailbox.");
  const value = validateTrackingDoc(doc);
  return SecureDurableResourceService.write({ ...session, resourceKey: key, value, expected, isCurrent, validateReadback: validateTrackingDoc });
}
