import { formatMinor } from "./receipt-money";

/** A bill is flagged when it is strictly more than this many percent above its usual price. */
export const RISE_THRESHOLD_PERCENT = 20;
const LATEST_WITHIN_DAYS = 60;

/** Strictly above the threshold, in whole minor units so the 20% boundary is exact. */
export function exceedsRise(newMinor: number, baselineMinor: number): boolean {
  return baselineMinor > 0 && newMinor * 100 > baselineMinor * (100 + RISE_THRESHOLD_PERCENT);
}

/** One decimal, half-up, from integers only. */
export function risePercent(newMinor: number, baselineMinor: number): string {
  const tenths = Math.floor(((newMinor - baselineMinor) * 2000 + baselineMinor) / (2 * baselineMinor));
  return (tenths / 10).toFixed(1);
}

export interface PricePoint { at: Date; minor: number; receiptKey: string; label: string }

export interface PriceRise {
  latestMinor: number;
  baselineMinor: number;
  percent: string;
  /** The middle of the last three paid bills. Bills that came out the same make a usual amount, never an agreed price. */
  basis: "median_last_three";
  currency: string;
  /** The newest bill first, then the earlier paid bills it was compared with. */
  evidence: Array<{ ref: string; label: string; amountMinor: number; on: string }>;
}

const day = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

/**
 * A rise strictly more than 20% above the middle of the last three comparable paid bills. Receipts alone never
 * establish an agreed price (that needs an agreement), so this is always the usual amount. It needs three earlier
 * paid bills; with fewer there is no baseline and none is invented. `points` are paid bills of one merchant and
 * currency, oldest first.
 */
export function evaluatePriceRise(points: readonly PricePoint[], currency: string, now: Date): PriceRise | null {
  if (points.length < 4) return null;
  const latest = points[points.length - 1]!;
  if (now.getTime() - latest.at.getTime() > LATEST_WITHIN_DAYS * 86_400_000) return null;
  const earlier = points.slice(0, -1);
  const lastThree = earlier.slice(-3);
  const baseline = [...lastThree].sort((a, b) => a.minor - b.minor)[1]!.minor;
  if (!exceedsRise(latest.minor, baseline)) return null;
  return {
    latestMinor: latest.minor, baselineMinor: baseline, percent: risePercent(latest.minor, baseline), currency,
    basis: "median_last_three",
    evidence: [latest, ...lastThree.slice().reverse()].map((point) => ({ ref: point.receiptKey, label: point.label, amountMinor: point.minor, on: day(point.at) })),
  };
}

/** "Electricity is ₹1,950, up 32.7% from your usual ₹1,470." */
export function priceRiseSentence(name: string, rise: PriceRise): string {
  const usual = `your usual ${formatMinor(rise.baselineMinor, rise.currency)}`;
  return `${name} is ${formatMinor(rise.latestMinor, rise.currency)}, up ${rise.percent}% from ${usual}.`;
}
