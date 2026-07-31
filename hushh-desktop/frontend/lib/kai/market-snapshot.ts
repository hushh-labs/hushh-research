import { type KaiHomeInsightsV2 } from "@/lib/services/api-service";
import { KaiMarketHomeResourceService } from "@/lib/kai/kai-market-home-resource";
import { CacheService } from "@/lib/services/cache-service";

export type TickerMarketSnapshot = {
  last_price: number | null;
  change_pct: number | null;
  observed_at: string | null;
  source: string;
};

type SnapshotCandidate = {
  last_price: number;
  change_pct: number | null;
  observed_at: string | null;
  source: string;
};

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickLatestCandidate(
  current: SnapshotCandidate | null,
  candidate: SnapshotCandidate
): SnapshotCandidate {
  if (!current) return candidate;
  const currentEpoch = toEpoch(current.observed_at);
  const candidateEpoch = toEpoch(candidate.observed_at);
  if (candidateEpoch > currentEpoch) return candidate;
  if (candidateEpoch === currentEpoch && candidate.last_price !== current.last_price) {
    return candidate;
  }
  if (
    candidateEpoch === currentEpoch &&
    current.change_pct === null &&
    candidate.change_pct !== null
  ) {
    return candidate;
  }
  return current;
}

function collectRowCandidate(params: {
  ticker: string;
  source: string;
  symbol: unknown;
  price: unknown;
  changePct?: unknown;
  observedAt?: unknown;
  payloadGeneratedAt?: string | null;
}): SnapshotCandidate | null {
  const symbol = String(params.symbol || "")
    .trim()
    .toUpperCase();
  if (!symbol || symbol !== params.ticker) return null;

  const price = toFiniteNumber(params.price);
  if (price === null || price <= 0) return null;

  const observedAtRaw = String(params.observedAt || "").trim();
  const observedAt = observedAtRaw || params.payloadGeneratedAt || null;

  return {
    last_price: price,
    change_pct: toFiniteNumber(params.changePct),
    observed_at: observedAt,
    source: params.source,
  };
}

export function extractTickerMarketSnapshotFromKaiHome(
  payload: KaiHomeInsightsV2 | null | undefined,
  ticker: string
): TickerMarketSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const normalizedTicker = String(ticker || "")
    .trim()
    .toUpperCase();
  if (!normalizedTicker) return null;

  const generatedAt = typeof payload.generated_at === "string" ? payload.generated_at : null;
  let best: SnapshotCandidate | null = null;

  const watchlist = Array.isArray(payload.watchlist) ? payload.watchlist : [];
  for (const row of watchlist) {
    const candidate = collectRowCandidate({
      ticker: normalizedTicker,
      source: "market_home.watchlist",
      symbol: row?.symbol,
      price: row?.price,
      changePct: row?.change_pct,
      observedAt: row?.as_of,
      payloadGeneratedAt: generatedAt,
    });
    if (candidate) best = pickLatestCandidate(best, candidate);
  }

  const spotlights = Array.isArray(payload.spotlights) ? payload.spotlights : [];
  for (const row of spotlights) {
    const candidate = collectRowCandidate({
      ticker: normalizedTicker,
      source: "market_home.spotlights",
      symbol: row?.symbol,
      price: row?.price,
      changePct: row?.change_pct,
      observedAt: row?.as_of,
      payloadGeneratedAt: generatedAt,
    });
    if (candidate) best = pickLatestCandidate(best, candidate);
  }

  const moversBuckets = [
    ...(Array.isArray(payload.movers?.active) ? payload.movers.active : []),
    ...(Array.isArray(payload.movers?.gainers) ? payload.movers.gainers : []),
    ...(Array.isArray(payload.movers?.losers) ? payload.movers.losers : []),
  ];
  for (const row of moversBuckets) {
    const candidate = collectRowCandidate({
      ticker: normalizedTicker,
      source: "market_home.movers",
      symbol: row?.symbol,
      price: row?.price,
      changePct: row?.change_pct,
      observedAt: row?.as_of,
      payloadGeneratedAt: generatedAt,
    });
    if (candidate) best = pickLatestCandidate(best, candidate);
  }

  if (!best) return null;
  return {
    last_price: best.last_price,
    change_pct: best.change_pct,
    observed_at: best.observed_at,
    source: best.source,
  };
}

export function getLatestMarketSnapshotFromCache(
  userId: string,
  ticker: string
): TickerMarketSnapshot | null {
  const cache = CacheService.getInstance();
  const prefix = `kai_market_home_${userId}_`;
  let best: TickerMarketSnapshot | null = null;
  for (const key of cache.getStats().keys) {
    if (!key.startsWith(prefix)) continue;
    const payload = cache.get<KaiHomeInsightsV2>(key);
    if (!payload) continue;
    const candidate = extractTickerMarketSnapshotFromKaiHome(payload, ticker);
    if (!candidate || candidate.last_price === null || candidate.last_price <= 0) continue;
    if (!best) {
      best = candidate;
      continue;
    }
    best = pickPreferredMarketSnapshot(best, candidate);
  }
  return best;
}

export async function fetchLatestMarketSnapshot(
  params: {
    userId: string;
    ticker: string;
    vaultOwnerToken: string;
    daysBack?: number;
  }
): Promise<TickerMarketSnapshot | null> {
  const payload = await KaiMarketHomeResourceService.getStaleFirst({
    userId: params.userId,
    vaultOwnerToken: params.vaultOwnerToken,
    symbols: [params.ticker],
    daysBack: params.daysBack ?? 7,
    forceRefresh: false,
    backgroundRefresh: true,
    allowDefaultNetworkFallback: false,
  });
  return extractTickerMarketSnapshotFromKaiHome(payload, params.ticker);
}

export function pickPreferredMarketSnapshot(
  current: TickerMarketSnapshot | null,
  candidate: TickerMarketSnapshot | null
): TickerMarketSnapshot | null {
  if (!candidate || candidate.last_price === null || candidate.last_price <= 0) {
    return current;
  }
  if (!current || current.last_price === null || current.last_price <= 0) {
    return candidate;
  }
  const currentEpoch = toEpoch(current.observed_at);
  const candidateEpoch = toEpoch(candidate.observed_at);
  if (candidateEpoch > currentEpoch) return candidate;
  if (candidateEpoch === currentEpoch && candidate.last_price !== current.last_price) {
    return candidate;
  }
  if (
    candidateEpoch === currentEpoch &&
    current.change_pct === null &&
    candidate.change_pct !== null
  ) {
    return candidate;
  }
  return current;
}
