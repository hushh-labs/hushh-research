"use client";

import {
  ApiService,
  type KaiHomeInsightsV2,
  type KaiHomeMover,
  type KaiHomeSpotlightItem,
  type KaiHomeWatchlistItem,
} from "@/lib/services/api-service";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";
import {
  DeviceResourceCacheService,
} from "@/lib/services/device-resource-cache-service";

const DEVICE_TTL_MS = 24 * 60 * 60 * 1000;
const inflightRefreshes = new Map<string, Promise<KaiHomeInsightsV2>>();

const TICKER_CANDIDATE_RE = /^[A-Z][A-Z0-9.-]{0,5}$/;
const EXCLUDED_SYMBOLS = new Set([
  "CASH",
  "MMF",
  "SWEEP",
  "QACDS",
  "BUY",
  "SELL",
  "REINVEST",
  "DIVIDEND",
  "INTEREST",
  "TRANSFER",
  "WITHDRAWAL",
  "DEPOSIT",
]);

function toSymbolsKey(symbols: string[]): string {
  if (!Array.isArray(symbols) || symbols.length === 0) return "default";
  return [...symbols].sort((a, b) => a.localeCompare(b)).join("-");
}

function hasUsefulOverviewValue(value: string | number | null | undefined): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const text = value.trim().toLowerCase();
  return Boolean(text) && !["n/a", "na", "unknown", "unavailable", "none", "null", "--", "-"].includes(text);
}

function countUsableOverviewRows(payload: KaiHomeInsightsV2 | null | undefined): number {
  const rows = payload?.market_overview;
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((count, row) => {
    if (!row) return count;
    return hasUsefulOverviewValue(row.value) ? count + 1 : count;
  }, 0);
}

function withStableOverviewFromCache(
  nextPayload: KaiHomeInsightsV2,
  cachedPayload: KaiHomeInsightsV2 | null
): KaiHomeInsightsV2 {
  const nextUsableCount = countUsableOverviewRows(nextPayload);
  const cachedUsableCount = countUsableOverviewRows(cachedPayload);
  if (nextUsableCount > 0 || cachedUsableCount === 0) {
    return nextPayload;
  }
  return {
    ...nextPayload,
    market_overview: cachedPayload?.market_overview ?? nextPayload.market_overview,
  };
}

function readCachedPortfolioHoldings(userId: string): Array<Record<string, unknown>> {
  const cache = CacheService.getInstance();
  const cachedPortfolio = cache.get<Record<string, unknown>>(CACHE_KEYS.PORTFOLIO_DATA(userId));
  const nestedPortfolio =
    cachedPortfolio?.portfolio &&
    typeof cachedPortfolio.portfolio === "object" &&
    !Array.isArray(cachedPortfolio.portfolio)
      ? (cachedPortfolio.portfolio as Record<string, unknown>)
      : null;
  return (
    (Array.isArray(cachedPortfolio?.holdings) && cachedPortfolio.holdings) ||
    (Array.isArray(nestedPortfolio?.holdings) && nestedPortfolio.holdings) ||
    []
  ) as Array<Record<string, unknown>>;
}

function toStoredRecordKey(params: {
  pickSource: string;
  daysBack: number;
  symbolsKey: string;
}): string {
  return `kai_market_home:${params.pickSource}:${params.daysBack}:${params.symbolsKey}`;
}

type CachedMarketCandidate = {
  payload: KaiHomeInsightsV2;
  cacheKey: string;
  isFresh: boolean;
};

type StoredMarketCandidate = {
  payload: KaiHomeInsightsV2;
  resourceKey: string;
};

function readAnyCachedMarketHome(params: {
  userId: string;
  daysBack?: number;
  pickSource?: string;
}): CachedMarketCandidate | null {
  const cache = CacheService.getInstance();
  const daysBack = params.daysBack ?? 7;
  const pickSource = params.pickSource ?? "default";
  const prefix = `kai_market_home_${params.userId}_`;
  const preferredSuffix = `_${daysBack}_${pickSource}`;
  const keys = cache
    .getStats()
    .keys.filter((key) => key.startsWith(prefix) && key.endsWith(preferredSuffix))
    .sort();

  let bestCandidate: CachedMarketCandidate | null = null;

  for (const key of keys) {
    const snapshot = cache.peek<KaiHomeInsightsV2>(key);
    if (!snapshot) continue;
    const candidate = {
      payload: snapshot.data,
      cacheKey: key,
      isFresh: snapshot.isFresh,
    };
    if (!bestCandidate) {
      bestCandidate = candidate;
      continue;
    }
    if (snapshot.timestamp > cache.peek<KaiHomeInsightsV2>(bestCandidate.cacheKey)!.timestamp) {
      bestCandidate = candidate;
    }
  }
  return bestCandidate;
}

async function readAnyStoredMarketHome(params: {
  userId: string;
  daysBack?: number;
  pickSource?: string;
}): Promise<StoredMarketCandidate | null> {
  const daysBack = params.daysBack ?? 7;
  const pickSource = params.pickSource ?? "default";
  const stored = await DeviceResourceCacheService.readLatestByPrefix<KaiHomeInsightsV2>({
    userId: params.userId,
    resourcePrefix: `kai_market_home:${pickSource}:${daysBack}:`,
  });
  if (!stored) {
    return null;
  }
  return {
    payload: stored.value,
    resourceKey: stored.resourceKey,
  };
}

function hasUsableNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasUsableText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return Boolean(text) && !["n/a", "na", "unknown", "unavailable", "none", "null", "--", "-"].includes(text.toLowerCase());
}

type MergeableQuoteRow = {
  symbol?: string;
  price?: number | null;
  change_pct?: number | null;
  as_of?: string | null;
  source_tags?: string[];
  degraded?: boolean;
};

function mergeQuoteRows<T extends MergeableQuoteRow>(
  nextRows: unknown,
  cachedRows: unknown
): T[] | undefined {
  const next = Array.isArray(nextRows)
    ? nextRows.filter((row): row is T => Boolean(row) && typeof row === "object")
    : [];
  const cached = Array.isArray(cachedRows)
    ? cachedRows.filter((row): row is T => Boolean(row) && typeof row === "object")
    : [];

  if (next.length === 0) {
    return cached.length > 0 ? cached : undefined;
  }

  if (cached.length === 0) {
    return next;
  }

  const cachedBySymbol = new Map(
    cached
      .map((row) => [String(row.symbol || "").trim().toUpperCase(), row] as const)
      .filter(([symbol]) => Boolean(symbol))
  );

  return next.map((row) => {
    const symbol = String(row.symbol || "").trim().toUpperCase();
    const baseline = symbol ? cachedBySymbol.get(symbol) : null;
    if (!baseline) {
      return row;
    }

    const merged = { ...row };
    const nextPrice = row.price;
    const cachedPrice = baseline.price;
    const nextChangePct = row.change_pct;
    const cachedChangePct = baseline.change_pct;
    const nextAsOf = row.as_of;
    const cachedAsOf = baseline.as_of;
    const nextSourceTags = row.source_tags;
    const cachedSourceTags = baseline.source_tags;

    if (!hasUsableNumber(nextPrice) && hasUsableNumber(cachedPrice)) {
      merged.price = cachedPrice;
      merged.degraded = true;
      if (!hasUsableNumber(nextChangePct) && hasUsableNumber(cachedChangePct)) {
        merged.change_pct = cachedChangePct;
      }
      if (!hasUsableText(nextAsOf) && hasUsableText(cachedAsOf)) {
        merged.as_of = cachedAsOf;
      }
      if (
        (!Array.isArray(nextSourceTags) || nextSourceTags.length === 0) &&
        Array.isArray(cachedSourceTags)
      ) {
        merged.source_tags = cachedSourceTags;
      }
    }

    return merged as T;
  });
}

function withStablePayloadFromCache(
  nextPayload: KaiHomeInsightsV2,
  cachedPayload: KaiHomeInsightsV2 | null
): KaiHomeInsightsV2 {
  const stabilized = withStableOverviewFromCache(nextPayload, cachedPayload);
  if (!cachedPayload) {
    return stabilized;
  }

  const nextHero =
    stabilized.hero && typeof stabilized.hero === "object" && !Array.isArray(stabilized.hero)
      ? { ...stabilized.hero }
      : null;
  const cachedHero =
    cachedPayload.hero &&
    typeof cachedPayload.hero === "object" &&
    !Array.isArray(cachedPayload.hero)
      ? cachedPayload.hero
      : null;

  if (nextHero && cachedHero) {
    if (!hasUsableNumber(nextHero.total_value) && hasUsableNumber(cachedHero.total_value)) {
      nextHero.total_value = cachedHero.total_value;
      nextHero.degraded = true;
    }
    if (
      !hasUsableNumber(nextHero.day_change_value) &&
      hasUsableNumber(cachedHero.day_change_value)
    ) {
      nextHero.day_change_value = cachedHero.day_change_value;
      nextHero.degraded = true;
    }
    if (
      !hasUsableNumber(nextHero.day_change_pct) &&
      hasUsableNumber(cachedHero.day_change_pct)
    ) {
      nextHero.day_change_pct = cachedHero.day_change_pct;
      nextHero.degraded = true;
    }
  }

  const stabilizedMovers = stabilized.movers ?? cachedPayload.movers;
  const cachedMovers = cachedPayload.movers;

  return {
    ...stabilized,
    hero: nextHero ?? stabilized.hero,
    watchlist:
      mergeQuoteRows<KaiHomeWatchlistItem>(stabilized.watchlist, cachedPayload.watchlist) ??
      stabilized.watchlist,
    spotlights:
      mergeQuoteRows<KaiHomeSpotlightItem>(stabilized.spotlights, cachedPayload.spotlights) ??
      stabilized.spotlights,
    movers: stabilizedMovers
      ? {
          ...stabilizedMovers,
          active:
            mergeQuoteRows<KaiHomeMover>(stabilizedMovers.active, cachedMovers?.active) ??
            stabilizedMovers.active ??
            [],
          gainers:
            mergeQuoteRows<KaiHomeMover>(stabilizedMovers.gainers, cachedMovers?.gainers) ??
            stabilizedMovers.gainers ??
            [],
          losers:
            mergeQuoteRows<KaiHomeMover>(stabilizedMovers.losers, cachedMovers?.losers) ??
            stabilizedMovers.losers ??
            [],
        }
      : stabilized.movers,
  };
}

function logRequest(stage: string, detail: Record<string, unknown>): void {
  console.info(`[RequestAudit:kai_market_home] ${stage}`, detail);
}

export class KaiMarketHomeResourceService {
  static resolveTrackedSymbols(userId: string): string[] {
    return readCachedPortfolioHoldings(userId)
      .filter((holding) => {
        const assetType = String(holding.asset_type || "").trim().toLowerCase();
        const name = String(holding.name || "").trim().toLowerCase();
        if (assetType.includes("cash") || assetType.includes("sweep")) return false;
        if (name.includes("cash") || name.includes("sweep")) return false;
        return true;
      })
      .map((holding) => String(holding.symbol || "").trim().toUpperCase())
      .filter(
        (symbol, index, arr) =>
          Boolean(symbol) &&
          !EXCLUDED_SYMBOLS.has(symbol) &&
          TICKER_CANDIDATE_RE.test(symbol) &&
          arr.indexOf(symbol) === index
      )
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 8);
  }

  static async getStaleFirst(params: {
    userId: string;
    vaultOwnerToken?: string | null;
    pickSource?: string;
    symbols?: string[];
    daysBack?: number;
    forceRefresh?: boolean;
    backgroundRefresh?: boolean;
    allowDefaultNetworkFallback?: boolean;
  }): Promise<KaiHomeInsightsV2 | null> {
    const pickSource = params.pickSource ?? "default";
    const daysBack = params.daysBack ?? 7;
    const symbolsKey = toSymbolsKey(params.symbols || []);
    const cacheKey = CACHE_KEYS.KAI_MARKET_HOME(params.userId, symbolsKey, daysBack, pickSource);
    const cache = CacheService.getInstance();
    const memory = cache.peek<KaiHomeInsightsV2>(cacheKey);

    if (!params.forceRefresh && memory?.isFresh) {
      logRequest("cache_hit", {
        tier: "memory",
        userId: params.userId,
        cacheKey,
      });
      return memory.data;
    }

    if (!params.forceRefresh && memory?.data) {
      logRequest("stale_hit", {
        tier: "memory",
        userId: params.userId,
        cacheKey,
      });
      if (params.backgroundRefresh !== false) {
        void this.refresh(params);
      }
      return memory.data;
    }

    if (!params.forceRefresh) {
      const stored = await DeviceResourceCacheService.read<KaiHomeInsightsV2>({
        userId: params.userId,
        resourceKey: toStoredRecordKey({ pickSource, daysBack, symbolsKey }),
      });
      if (stored) {
        cache.set(cacheKey, stored, CACHE_TTL.MEDIUM);
        logRequest("device_hit", {
          userId: params.userId,
          cacheKey,
        });
        if (params.backgroundRefresh !== false) {
          void this.refresh(params);
        }
        return stored;
      }
    }

    if (!params.forceRefresh) {
      const anyMemory = readAnyCachedMarketHome({
        userId: params.userId,
        daysBack,
        pickSource,
      });
      if (anyMemory?.payload) {
        cache.set(cacheKey, anyMemory.payload, CACHE_TTL.MEDIUM);
        logRequest("cache_hit", {
          tier: "memory_fallback",
          userId: params.userId,
          cacheKey,
          fallbackCacheKey: anyMemory.cacheKey,
        });
        if (params.backgroundRefresh !== false) {
          void this.refresh(params);
        }
        return anyMemory.payload;
      }
    }

    if (!params.forceRefresh) {
      const storedFallback = await readAnyStoredMarketHome({
        userId: params.userId,
        daysBack,
        pickSource,
      });
      if (storedFallback?.payload) {
        cache.set(cacheKey, storedFallback.payload, CACHE_TTL.MEDIUM);
        logRequest("device_hit", {
          tier: "device_fallback",
          userId: params.userId,
          cacheKey,
          fallbackResourceKey: storedFallback.resourceKey,
        });
        if (params.backgroundRefresh !== false) {
          void this.refresh(params);
        }
        return storedFallback.payload;
      }
    }

    logRequest("cache_miss", {
      userId: params.userId,
      cacheKey,
    });
    if (!params.vaultOwnerToken) {
      logRequest("refresh_skipped", {
        reason: "missing_vault_owner_token",
        userId: params.userId,
        cacheKey,
      });
      return null;
    }
    return await this.refresh(params);
  }

  static async refresh(params: {
    userId: string;
    vaultOwnerToken?: string | null;
    pickSource?: string;
    symbols?: string[];
    daysBack?: number;
    allowDefaultNetworkFallback?: boolean;
  }): Promise<KaiHomeInsightsV2> {
    const pickSource = params.pickSource ?? "default";
    const daysBack = params.daysBack ?? 7;
    const symbols = Array.isArray(params.symbols) ? params.symbols : [];
    const symbolsKey = toSymbolsKey(symbols);
    const cacheKey = CACHE_KEYS.KAI_MARKET_HOME(params.userId, symbolsKey, daysBack, pickSource);
    const inflightKey = `${params.userId}:${pickSource}:${daysBack}:${symbolsKey}`;
    const cache = CacheService.getInstance();
    const existing = inflightRefreshes.get(inflightKey);
    if (existing) {
      logRequest("inflight_dedupe_hit", {
        userId: params.userId,
        cacheKey,
      });
      return await existing;
    }

    logRequest("network_fetch", {
      userId: params.userId,
      cacheKey,
    });
    const request = (async () => {
      const baseline =
        cache.peek<KaiHomeInsightsV2>(cacheKey)?.data ??
        readAnyCachedMarketHome({
          userId: params.userId,
          daysBack,
          pickSource,
        })?.payload ??
        null;
      const vaultOwnerToken = String(params.vaultOwnerToken || "").trim();
      if (!vaultOwnerToken) {
        if (baseline) {
          logRequest("stale_hit", {
            tier: "missing_token_fallback",
            userId: params.userId,
            cacheKey,
          });
          return baseline;
        }
        throw new Error("Missing vault owner token for market refresh");
      }

      try {
        const payload = await ApiService.getKaiMarketInsights({
          userId: params.userId,
          vaultOwnerToken,
          symbols: symbols.length > 0 ? symbols : undefined,
          daysBack,
          pickSource,
        });
        const stabilized = withStablePayloadFromCache(payload, baseline);
        cache.set(cacheKey, stabilized, CACHE_TTL.MEDIUM);
        await DeviceResourceCacheService.write({
          userId: params.userId,
          resourceKey: toStoredRecordKey({ pickSource, daysBack, symbolsKey }),
          value: stabilized,
          ttlMs: DEVICE_TTL_MS,
        });
        return stabilized;
      } catch (error) {
        if (baseline) {
          logRequest("stale_hit", {
            tier: "refresh_failure_fallback",
            userId: params.userId,
            cacheKey,
          });
          return baseline;
        }
        if (symbols.length > 0 && params.allowDefaultNetworkFallback !== false) {
          const fallback = await ApiService.getKaiMarketInsights({
            userId: params.userId,
            vaultOwnerToken,
            daysBack,
            pickSource,
          });
          const stabilized = withStablePayloadFromCache(fallback, baseline);
          const fallbackKey = CACHE_KEYS.KAI_MARKET_HOME(params.userId, "default", daysBack, pickSource);
          cache.set(cacheKey, stabilized, CACHE_TTL.MEDIUM);
          cache.set(fallbackKey, stabilized, CACHE_TTL.MEDIUM);
          await DeviceResourceCacheService.write({
            userId: params.userId,
            resourceKey: toStoredRecordKey({
              pickSource,
              daysBack,
              symbolsKey,
            }),
            value: stabilized,
            ttlMs: DEVICE_TTL_MS,
          });
          await DeviceResourceCacheService.write({
            userId: params.userId,
            resourceKey: toStoredRecordKey({
              pickSource,
              daysBack,
              symbolsKey: "default",
            }),
            value: stabilized,
            ttlMs: DEVICE_TTL_MS,
          });
          return stabilized;
        }
        throw error;
      }
    })().finally(() => {
      if (inflightRefreshes.get(inflightKey) === request) {
        inflightRefreshes.delete(inflightKey);
      }
    });

    inflightRefreshes.set(inflightKey, request);
    return await request;
  }

  static invalidateUser(userId: string, options?: { includeDevice?: boolean }): void {
    const cache = CacheService.getInstance();
    cache.invalidatePattern(`kai_market_home_${userId}_`);
    if (options?.includeDevice) {
      void DeviceResourceCacheService.invalidateResourcePrefix(userId, "kai_market_home:");
    }
  }
}
