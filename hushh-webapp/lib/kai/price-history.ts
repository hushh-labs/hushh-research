/** Observed prices only, normalized at the service boundary. */
export interface PriceHistoryPoint { date: string; value: number }
export interface StockPriceHistory {
  points: PriceHistoryPoint[];
  stale: boolean;
  retrievedAt: string | null;
  source?: string | null;
  cached?: boolean;
  unavailableReason?: "provider_unavailable" | "unsupported_symbol" | "insufficient_observations" | "request_failed" | null;
}
export type PriceRange = "1w" | "1m" | "3m" | "1y" | "all";
export const PRICE_RANGE_LABELS: Record<PriceRange, string> = {
  "1w": "1W", "1m": "1M", "3m": "3M", "1y": "1Y", all: "All",
};

export function normalizePriceHistory(points: PriceHistoryPoint[]): PriceHistoryPoint[] {
  const byTime = new Map<number, PriceHistoryPoint>();
  for (const point of points) {
    const time = Date.parse(point.date);
    if (Number.isFinite(time) && Number.isFinite(point.value) && point.value >= 0)
      byTime.set(time, point);
  }
  return [...byTime.entries()].sort(([a], [b]) => a - b).map(([, point]) => point);
}

export function priceHistoryRanges(points: PriceHistoryPoint[]): PriceRange[] {
  const days = (Date.parse(points.at(-1)?.date ?? "") - Date.parse(points[0]?.date ?? "")) / 86_400_000;
  return (["1w", "1m", "3m", "1y"] as const)
    .filter(range => days >= ({ "1w": 7, "1m": 28, "3m": 90, "1y": 365 })[range]
      && slicePriceHistory(points, range).length >= 2);
}

export function slicePriceHistory(points: PriceHistoryPoint[], range: PriceRange): PriceHistoryPoint[] {
  if (range === "all") return points;
  const days = { "1w": 7, "1m": 30, "3m": 90, "1y": 365 }[range];
  const cutoff = Date.parse(points.at(-1)?.date ?? "") - days * 86_400_000;
  return points.filter(point => Date.parse(point.date) >= cutoff);
}
