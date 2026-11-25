import type { RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import { type Cadence, detectCadence, isoDate, merchantSeries, rollForward } from "./receipt-cadence";
import { formatMinor } from "./receipt-money";
import { type PriceRise, evaluatePriceRise } from "./receipt-price-rise";

export interface DetectedBill {
  patternKey: string;
  name: string;
  kind: "fixed" | "variable";
  currency: string;
  frequency: Cadence;
  /** Agreed price for a fixed bill, in minor units. */
  agreedMinor: number | null;
  /** The day of the month the receipts cluster around. */
  anchorDay: number;
  nextOn: string;
  reason: string;
  icon: string;
  evidence: Array<{ ref: string; label: string; amountMinor: number; on: string }>;
  history: Array<{ paidOn: string; amountMinor: number; ref: string }>;
  /** Set only when the newest paid bill is strictly more than 20% above its usual price. */
  priceRise: PriceRise | null;
  /** The newest paid bill, for "Last" amounts. */
  lastPaid: { paidOn: string; amountMinor: number } | null;
}

const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const ICONS: Record<string, string> = { Bills: "bill", Subscription: "tv", "Software & Subscriptions": "tv" };

function ordinal(day: number): string {
  const mod = day % 100;
  const suffix = mod >= 11 && mod <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th";
  return `${day}${suffix}`;
}

/** Recurring bills that the saved receipts themselves show. A pattern never carries payment authority. */
export function detectRecurringBills(rows: readonly RecentReceiptRow[], today: Date = new Date()): DetectedBill[] {
  const bills: DetectedBill[] = [];
  for (const series of merchantSeries(rows)) {
    const cadence = detectCadence(series.points);
    if (!cadence || series.points.length < 3) continue;
    const amounts = series.points.map((point) => point.minor);
    const priceRise = evaluatePriceRise(series.points.map((point) => ({ at: point.at, minor: point.minor, receiptKey: point.receiptKey, label: series.merchant })), series.currency, today);
    // A bill that never changed until its newest receipt is still a fixed bill with an agreed price.
    const fixed = new Set(amounts).size === 1 || priceRise?.basis === "agreed_price";
    const days = series.points.map((point) => point.at.getDate()).sort((a, b) => a - b);
    const anchorDay = days[Math.floor(days.length / 2)]!;
    const count = series.points.length;
    const low = Math.min(...amounts);
    const high = Math.max(...amounts);
    const span = cadence === "weekly" ? "every week" : `around the ${ordinal(days[0]!)}${days[0] === days.at(-1) ? "" : ` to ${ordinal(days.at(-1)!)}`}`;
    const money = new Set(amounts).size === 1 ? formatMinor(low, series.currency) : `${formatMinor(low, series.currency)} to ${formatMinor(high, series.currency)}`;
    bills.push({
      patternKey: `pattern:${series.key}`,
      name: series.merchant,
      kind: fixed ? "fixed" : "variable",
      currency: series.currency,
      frequency: cadence,
      agreedMinor: fixed ? (priceRise?.basis === "agreed_price" ? priceRise.baselineMinor : low) : null,
      anchorDay,
      nextOn: rollForward(isoDate(series.points.at(-1)!.at), cadence, anchorDay, today),
      reason: `${WORDS[count] ?? count} receipts show ${money} paid ${span}.`,
      icon: (series.category && ICONS[series.category]) || "bill",
      evidence: series.points.slice(-6).map((point) => ({ ref: point.receiptKey, label: series.merchant, amountMinor: point.minor, on: isoDate(point.at) })),
      history: series.points.slice(-6).map((point) => ({ paidOn: isoDate(point.at), amountMinor: point.minor, ref: point.receiptKey })),
      priceRise,
      lastPaid: { paidOn: isoDate(series.points.at(-1)!.at), amountMinor: series.points.at(-1)!.minor },
    });
  }
  return bills;
}
