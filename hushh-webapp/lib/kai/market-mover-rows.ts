import { normalizeMarketSymbol } from "@/lib/kai/market-symbol";
import type { KaiHomeInsightsV2, KaiHomeRenaissanceItem, KaiHomeWatchlistItem } from "@/lib/services/api-service";

export type OneMarketDisplayRow = {
  symbol: string;
  companyName: string;
  price: number | null;
  changePct: number | null;
  volume?: number | null;
  sparkline?: number[] | null;
  degraded?: boolean;
  asOf?: string | null;
};

export type OneMarketMoverTab = "gain" | "lose" | "active";

function toOneMarketRows(
  rows:
    | Array<
        | KaiHomeWatchlistItem
        | KaiHomeRenaissanceItem
        | NonNullable<KaiHomeInsightsV2["movers"]>["gainers"][number]
      >
    | null
    | undefined,
): OneMarketDisplayRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const sparklineSource = (
        row as { sparkline?: unknown } | null | undefined
      )?.sparkline;
      const sparkline =
        Array.isArray(sparklineSource) && sparklineSource.length > 1
          ? sparklineSource.filter(
              (point): point is number =>
                typeof point === "number" && Number.isFinite(point),
            )
          : null;
      return {
        symbol: normalizeMarketSymbol(row?.symbol),
        companyName: String(
          row?.company_name || row?.symbol || "Market name",
        ).trim(),
        price:
          typeof row?.price === "number" && Number.isFinite(row.price)
            ? row.price
            : null,
        changePct:
          typeof row?.change_pct === "number" && Number.isFinite(row.change_pct)
            ? row.change_pct
            : null,
        volume:
          typeof row?.volume === "number" && Number.isFinite(row.volume)
            ? row.volume
            : null,
        sparkline: sparkline && sparkline.length > 1 ? sparkline : null,
        degraded: Boolean(row?.degraded),
        asOf: row?.as_of ?? null,
      };
    })
    .filter((row) => Boolean(row.symbol));
}

function dedupeOneMarketRows(
  rows: OneMarketDisplayRow[],
): OneMarketDisplayRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.symbol.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isDirectionalMover(
  row: OneMarketDisplayRow,
  direction: "gain" | "lose",
): boolean {
  if (typeof row.changePct !== "number" || !Number.isFinite(row.changePct))
    return false;
  return direction === "gain" ? row.changePct > 0 : row.changePct < 0;
}

export function toMoverGroups(
  payload: KaiHomeInsightsV2 | null,
): Record<OneMarketMoverTab, OneMarketDisplayRow[]> {
  // Provider buckets are advisory. The displayed direction must always agree
  // with the quote itself so a negative move can never appear in Gainers.
  const gainers = dedupeOneMarketRows(
    toOneMarketRows(payload?.movers?.gainers).filter((row) =>
      isDirectionalMover(row, "gain"),
    ),
  )
    .sort((left, right) => Number(right.changePct) - Number(left.changePct))
    .slice(0, 4);
  const losers = dedupeOneMarketRows(
    toOneMarketRows(payload?.movers?.losers).filter((row) =>
      isDirectionalMover(row, "lose"),
    ),
  )
    .sort((left, right) => Number(left.changePct) - Number(right.changePct))
    .slice(0, 4);
  const active = dedupeOneMarketRows(toOneMarketRows(payload?.movers?.active))
    .sort((left, right) => Number(right.volume || 0) - Number(left.volume || 0))
    .slice(0, 4);
  const groupDegraded = Boolean(payload?.movers?.degraded);
  const withGroupStatus = (rows: OneMarketDisplayRow[]) => rows.map((row) => ({
    ...row, degraded: Boolean(row.degraded || groupDegraded),
  }));
  return { gain: withGroupStatus(gainers), lose: withGroupStatus(losers), active: withGroupStatus(active) };
}

export function toMoverQuoteRow(row: OneMarketDisplayRow): KaiHomeRenaissanceItem {
  return {
    symbol: row.symbol,
    company_name: row.companyName,
    price: row.price,
    change_pct: row.changePct,
    volume: row.volume ?? null,
    market_cap: null,
    source_tags: [],
    degraded: Boolean(row.degraded),
    as_of: row.asOf ?? null,
    quoted_at: row.asOf ?? null,
  };
}
