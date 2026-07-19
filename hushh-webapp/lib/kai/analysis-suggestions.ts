import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import type { KaiHomeInsightsV2 } from "@/lib/services/api-service";

export type AnalysisSuggestionSource = "holding" | "mover" | "universe";

export type AnalysisSuggestion = {
  symbol: string;
  source: AnalysisSuggestionSource;
};

const APPROVED_TICKER_UNIVERSE = ["NVDA", "MSFT", "AAPL", "AMZN", "GOOGL", "META", "AVGO"];

function normalizedSymbol(value: unknown): string | null {
  const symbol = String(value || "").trim().toUpperCase();
  return /^[A-Z]{1,5}(?:[.-][A-Z])?$/.test(symbol) ? symbol : null;
}

function isEligibleHolding(value: Record<string, unknown>): boolean {
  if (value.analyze_eligible === false || value.is_investable === false) return false;
  const type = String(value.asset_type || "").toLowerCase();
  return !/(cash|sweep|bond|fixed income|fund|etf)/.test(type);
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sessionSeed(userId: string): string {
  if (typeof window === "undefined") return "server";
  const key = `hussh:analysis-suggestion-session:${userId}`;
  const existing = window.sessionStorage.getItem(key);
  if (existing) return existing;
  const seed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  window.sessionStorage.setItem(key, seed);
  return seed;
}

function rotate<T>(values: T[], seed: string): T[] {
  if (values.length < 2) return values;
  const offset = stableHash(seed) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function cachedHoldings(userId: string): string[] {
  const cache = CacheService.getInstance();
  const portfolio =
    cache.get<Record<string, unknown>>(CACHE_KEYS.PORTFOLIO_DATA(userId)) ??
    cache.get<Record<string, unknown>>(CACHE_KEYS.DOMAIN_DATA(userId, "financial"));
  const nested = portfolio?.portfolio;
  const holdings = Array.isArray(portfolio?.holdings)
    ? portfolio.holdings
    : nested && typeof nested === "object" && Array.isArray((nested as Record<string, unknown>).holdings)
      ? (nested as Record<string, unknown>).holdings as unknown[]
      : [];
  return holdings.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const holding = value as Record<string, unknown>;
    const symbol = normalizedSymbol(holding.symbol);
    return symbol && isEligibleHolding(holding) ? [symbol] : [];
  });
}

function cachedMoverSymbols(userId: string): string[] {
  const cache = CacheService.getInstance();
  const prefix = `kai_market_home_${userId}_`;
  const results: string[] = [];
  for (const key of cache.getStats().keys) {
    if (!key.startsWith(prefix)) continue;
    const payload = cache.get<KaiHomeInsightsV2>(key);
    const movers = payload?.movers;
    for (const row of [
      ...(Array.isArray(movers?.gainers) ? movers.gainers : []),
      ...(Array.isArray(movers?.active) ? movers.active : []),
      ...(Array.isArray(movers?.losers) ? movers.losers : []),
    ]) {
      const symbol = normalizedSymbol(row?.symbol);
      if (symbol) results.push(symbol);
    }
  }
  return results;
}

/** Cache-only, neutral research starters. This function never fetches data. */
export function getAnalysisSuggestions(input: {
  userId: string;
  activeSymbol?: string | null;
  previewSymbol?: string | null;
  recentSymbols?: readonly string[];
  limit?: number;
}): AnalysisSuggestion[] {
  const excluded = new Set(
    [input.activeSymbol, input.previewSymbol, ...(input.recentSymbols || [])]
      .map(normalizedSymbol)
      .filter((value): value is string => Boolean(value)),
  );
  const seed = `${input.userId}:${dayKey()}:${sessionSeed(input.userId)}`;
  const sources: Array<[AnalysisSuggestionSource, string[]]> = [
    ["holding", cachedHoldings(input.userId)],
    ["mover", cachedMoverSymbols(input.userId)],
    ["universe", APPROVED_TICKER_UNIVERSE],
  ];
  const suggestions: AnalysisSuggestion[] = [];
  for (const [source, symbols] of sources) {
    for (const symbol of rotate(symbols, `${seed}:${source}`)) {
      if (excluded.has(symbol)) continue;
      excluded.add(symbol);
      suggestions.push({ symbol, source });
      if (suggestions.length >= Math.max(3, Math.min(input.limit ?? 5, 5))) {
        return suggestions;
      }
    }
  }
  return suggestions;
}
