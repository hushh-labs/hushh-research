import type { RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import { receiptMoneyKind } from "./receipt-month-summary";
import { toMinor } from "./receipt-money";

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

const DAY = 86_400_000;
const RANGES: Array<[Cadence, number, number]> = [
  ["weekly", 6, 8],
  ["monthly", 26, 35],
  ["quarterly", 85, 97],
  ["yearly", 355, 375],
];

export interface MerchantSeries {
  key: string;
  merchant: string;
  currency: string;
  category: RecentReceiptRow["category"];
  /** Payments only, oldest first, with known amounts. */
  points: Array<{ at: Date; minor: number; rowId: string; receiptKey: string }>;
}

export function merchantKey(row: RecentReceiptRow): string {
  return (row.brandKey || row.merchantName).trim().toLowerCase();
}

/** Group paid receipts by merchant and currency. Amounts or dates that are unknown are left out. */
export function merchantSeries(rows: readonly RecentReceiptRow[]): MerchantSeries[] {
  const groups = new Map<string, MerchantSeries>();
  for (const row of rows) {
    if (row.archived || receiptMoneyKind(row) !== "payment" || !row.receiptDate) continue;
    const at = new Date(row.receiptDate);
    const minor = toMinor(row.amount, row.currency);
    if (Number.isNaN(at.getTime()) || minor === null || !row.currency) continue;
    const currency = row.currency.trim().toUpperCase();
    const key = `${merchantKey(row)}|${currency}`;
    const group = groups.get(key) ?? { key, merchant: row.merchantName, currency, category: row.category, points: [] };
    group.points.push({ at, minor, rowId: row.id, receiptKey: row.primaryReceiptKey });
    groups.set(key, group);
  }
  for (const group of groups.values()) group.points.sort((a, b) => a.at.getTime() - b.at.getTime());
  return [...groups.values()];
}

/** The cadence at least 70% of the gaps agree on, or null when the dates are irregular. */
export function detectCadence(points: ReadonlyArray<{ at: Date }>): Cadence | null {
  if (points.length < 3) return null;
  const gaps = points.slice(1).map((point, index) => (point.at.getTime() - points[index]!.at.getTime()) / DAY);
  for (const [cadence, low, high] of RANGES) {
    const fits = gaps.filter((gap) => gap >= low && gap <= high).length;
    if (fits / gaps.length >= 0.7) return cadence;
  }
  return null;
}

const STEP: Record<Cadence, number> = { weekly: 0, monthly: 1, quarterly: 3, yearly: 12 };

export function isoDate(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function parseIso(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1);
}

/** The cycle after `from`; monthly-style cycles keep the chosen day, clamped to short months. */
export function nextCycle(from: string, cadence: Cadence, anchorDay: number): string {
  const current = parseIso(from);
  if (cadence === "weekly") return isoDate(new Date(current.getFullYear(), current.getMonth(), current.getDate() + 7));
  const target = new Date(current.getFullYear(), current.getMonth() + STEP[cadence], 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return isoDate(new Date(target.getFullYear(), target.getMonth(), Math.min(anchorDay, last)));
}

/** The first cycle on or after `today`, counting forward from a known date. */
export function rollForward(from: string, cadence: Cadence, anchorDay: number, today: Date): string {
  const floor = isoDate(today);
  let next = from;
  for (let guard = 0; guard < 600 && next < floor; guard += 1) next = nextCycle(next, cadence, anchorDay);
  return next;
}
