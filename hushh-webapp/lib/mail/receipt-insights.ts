import type { RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import { detectCadence, merchantKey, merchantSeries } from "./receipt-cadence";
import { formatMinor, toMinor } from "./receipt-money";
import { type PriceRise, evaluatePriceRise, priceRiseSentence } from "./receipt-price-rise";
import { receiptMoneyKind } from "./receipt-month-summary";
import type { NoticeFinding, NoticeKind } from "./receipt-notice";

export type InsightKind = "duplicate_charge" | "missing_refund" | "price_rise" | "overlapping_plans";

export interface InsightPlan {
  key: string;
  label: string;
  /** Latest charge in minor units. */
  minor: number;
  currency: string;
  /** Only set when the plan's own receipts show a monthly rhythm. */
  monthlyMinor: number | null;
  receiptKey: string;
  rowId: string;
}

export interface ReceiptInsight {
  id: string;
  kind: InsightKind | NoticeKind;
  /** "notice" is a finding One's backend check made from the mailbox; the rest are read from saved receipts. */
  origin?: "notice" | "receipts";
  notice?: NoticeFinding;
  title: string;
  /** One short sentence that says why this was raised. */
  reason: string;
  /** Receipts that support it; each opens its exact source. */
  receiptKeys: string[];
  rowIds: string[];
  action: { label: string };
  plans?: InsightPlan[];
  rise?: PriceRise;
}

const DAY = 86_400_000;
const SUBSCRIPTION_CATEGORIES = new Set(["Software & Subscriptions", "Subscription"]);
export const OVERLAP_MIN_PLANS = 3;
export const REFUND_WAIT_DAYS = 7;
export const DUPLICATE_WINDOW_DAYS = 3;

function stableId(kind: InsightKind, keys: readonly string[]): string {
  let hash = 5381;
  for (const char of `${kind}|${[...keys].sort().join("|")}`) hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  return `ins_${kind}_${hash.toString(36)}`;
}

function time(row: RecentReceiptRow): number {
  return row.receiptDate ? new Date(row.receiptDate).getTime() : NaN;
}

function shortDate(at: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(at);
}

function sameOrder(a: RecentReceiptRow, b: RecentReceiptRow): boolean {
  if (!a.identifiers.length || !b.identifiers.length) return true;
  const known = new Set(a.identifiers.map((item) => `${item.kind}:${item.value.trim().toUpperCase()}`));
  return b.identifiers.some((item) => known.has(`${item.kind}:${item.value.trim().toUpperCase()}`));
}

function duplicateCharges(rows: readonly RecentReceiptRow[]): ReceiptInsight[] {
  const payments = rows.filter((row) => !row.archived && receiptMoneyKind(row) === "payment" && Number.isFinite(time(row)));
  const found: ReceiptInsight[] = [];
  const used = new Set<string>();
  for (const [index, first] of payments.entries()) {
    for (const second of payments.slice(index + 1)) {
      const amount = toMinor(first.amount, first.currency);
      if (amount === null || amount !== toMinor(second.amount, second.currency)) continue;
      if (merchantKey(first) !== merchantKey(second) || first.currency !== second.currency) continue;
      if (Math.abs(time(first) - time(second)) > DUPLICATE_WINDOW_DAYS * DAY) continue;
      // Two receipts with different order numbers are two purchases, not a repeat.
      if (!sameOrder(first, second) || used.has(first.id) || used.has(second.id)) continue;
      used.add(first.id).add(second.id);
      found.push({
        id: stableId("duplicate_charge", [first.primaryReceiptKey, second.primaryReceiptKey]),
        kind: "duplicate_charge",
        title: `Possible double charge at ${first.merchantName}`,
        reason: `${formatMinor(amount, String(first.currency))} was charged twice within ${DUPLICATE_WINDOW_DAYS} days.`,
        receiptKeys: [first.primaryReceiptKey, second.primaryReceiptKey],
        rowIds: [first.id, second.id],
        action: { label: "Review charges" },
      });
    }
  }
  return found;
}

function missingRefunds(rows: readonly RecentReceiptRow[], now: Date): ReceiptInsight[] {
  const live = rows.filter((row) => !row.archived && Number.isFinite(time(row)));
  const found: ReceiptInsight[] = [];
  for (const cancelled of live.filter((row) => receiptMoneyKind(row) === "cancelled")) {
    if (now.getTime() - time(cancelled) < REFUND_WAIT_DAYS * DAY) continue;
    const purchase = live
      .filter((row) => receiptMoneyKind(row) === "payment" && merchantKey(row) === merchantKey(cancelled) && time(row) <= time(cancelled) && sameOrder(row, cancelled))
      .sort((a, b) => time(b) - time(a))[0];
    const amount = purchase ? toMinor(purchase.amount, purchase.currency) : null;
    if (!purchase || amount === null) continue;
    const refunded = live.some((row) => receiptMoneyKind(row) === "refund" && merchantKey(row) === merchantKey(cancelled) && time(row) >= time(cancelled) - DAY);
    if (refunded) continue;
    found.push({
      id: stableId("missing_refund", [purchase.primaryReceiptKey, cancelled.primaryReceiptKey]),
      kind: "missing_refund",
      title: `No refund seen from ${cancelled.merchantName}`,
      reason: `You cancelled on ${shortDate(time(cancelled))}, but no refund of ${formatMinor(amount, String(purchase.currency))} has arrived.`,
      receiptKeys: [purchase.primaryReceiptKey, cancelled.primaryReceiptKey],
      rowIds: [purchase.id, cancelled.id],
      action: { label: "Review refund" },
    });
  }
  return found;
}

function overlappingPlans(rows: readonly RecentReceiptRow[]): ReceiptInsight[] {
  const byCurrency = new Map<string, InsightPlan[]>();
  for (const series of merchantSeries(rows)) {
    const row = rows.find((item) => item.id === series.points.at(-1)!.rowId)!;
    if (row.recurrence !== "recurring" || !series.category || !SUBSCRIPTION_CATEGORIES.has(series.category)) continue;
    if (rows.some((item) => !item.archived && merchantKey(item) === series.key.split("|")[0] && receiptMoneyKind(item) === "cancelled" && time(item) > series.points.at(-1)!.at.getTime())) continue;
    const latest = series.points.at(-1)!;
    const plan: InsightPlan = {
      key: series.key,
      label: series.merchant,
      minor: latest.minor,
      currency: series.currency,
      monthlyMinor: detectCadence(series.points) === "monthly" ? latest.minor : null,
      receiptKey: latest.receiptKey,
      rowId: latest.rowId,
    };
    byCurrency.set(series.currency, [...(byCurrency.get(series.currency) ?? []), plan]);
  }
  return [...byCurrency.entries()]
    .filter(([, plans]) => plans.length >= OVERLAP_MIN_PLANS)
    .map(([currency, plans]) => {
      const allMonthly = plans.every((plan) => plan.monthlyMinor !== null);
      const total = plans.reduce((sum, plan) => sum + plan.minor, 0);
      return {
        id: stableId("overlapping_plans", plans.map((plan) => plan.key)),
        kind: "overlapping_plans" as const,
        title: `You pay for ${plans.length} subscription plans`,
        reason: allMonthly
          ? `${formatMinor(total, currency)} a month. Do you still use them all?`
          : `${formatMinor(total, currency)} across their latest charges. Do you still use them all?`,
        receiptKeys: plans.map((plan) => plan.receiptKey),
        rowIds: plans.map((plan) => plan.rowId),
        action: { label: "Review plans" },
        plans,
      };
    });
}

function priceRises(rows: readonly RecentReceiptRow[], now: Date): ReceiptInsight[] {
  const found: ReceiptInsight[] = [];
  for (const series of merchantSeries(rows)) {
    if (!detectCadence(series.points)) continue;
    const rise = evaluatePriceRise(series.points.map((point) => ({ at: point.at, minor: point.minor, receiptKey: point.receiptKey, label: series.merchant })), series.currency, now);
    if (!rise) continue;
    const refs = rise.evidence.map((item) => item.ref);
    found.push({
      id: stableId("price_rise", refs.slice(0, 1)),
      kind: "price_rise",
      title: `${series.merchant} went up ${rise.percent}%`,
      reason: priceRiseSentence(series.merchant, rise),
      receiptKeys: refs,
      rowIds: rise.evidence.map((item) => series.points.find((point) => point.receiptKey === item.ref)!.rowId),
      action: { label: "Review bill" },
      rise,
    });
  }
  return found;
}

/** Most urgent first: money possibly lost, then money owed back, then a price rise, then spend to trim. */
export function buildReceiptInsights(rows: readonly RecentReceiptRow[], now: Date = new Date()): ReceiptInsight[] {
  return [...duplicateCharges(rows), ...missingRefunds(rows, now), ...priceRises(rows, now), ...overlappingPlans(rows)];
}

/**
 * The provider's own cancellation receipt for a plan the owner chose to cancel: same merchant, a cancellation
 * (never a purchase), dated on or after the day the choice was saved. A choice alone is never proof.
 */
export function findCancellationProof(rows: readonly RecentReceiptRow[], planKey: string, requestedAt: string): RecentReceiptRow | null {
  const merchant = planKey.slice(0, planKey.lastIndexOf("|"));
  const since = new Date(requestedAt);
  since.setHours(0, 0, 0, 0);
  return rows.find((row) => {
    if (row.archived || receiptMoneyKind(row) !== "cancelled" || merchantKey(row) !== merchant) return false;
    const at = row.receiptDate ? new Date(row.receiptDate).getTime() : NaN;
    return Number.isFinite(at) && at >= since.getTime();
  }) ?? null;
}
