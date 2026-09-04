"use client";

import {
  ApiService,
  MarketNewsSnapshotChangedError,
  type KaiMarketNewsPage,
} from "@/lib/services/api-service";
import { logRequestAudit } from "@/lib/cache/request-audit-log";
import {
  CacheService,
  CACHE_KEYS,
  CACHE_TTL,
} from "@/lib/services/cache-service";
import { DeviceResourceCacheService } from "@/lib/services/device-resource-cache-service";

const DEVICE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS_BACK = 7;
const DEFAULT_LIMIT = 12;

type MarketNewsMode = "baseline" | "personalized";

export type KaiMarketNewsResourceRequest = {
  userId: string;
  mode: MarketNewsMode;
  vaultOwnerToken?: string | null;
  symbols?: readonly string[] | null;
  cursor?: string | null;
  limit?: number;
  daysBack?: number;
  forceRefresh?: boolean;
  backgroundRefresh?: boolean;
};

const inflightRefreshes = new Map<string, Promise<KaiMarketNewsPage | null>>();

function normalizeSymbols(symbols: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(symbols)) return [];
  return symbols
    .map((symbol) => String(symbol || "").trim().toUpperCase())
    .filter(Boolean)
    .filter((symbol, index, rows) => rows.indexOf(symbol) === index)
    .slice(0, 3);
}

function scopeFor(params: KaiMarketNewsResourceRequest): string {
  if (params.mode === "baseline") return "baseline";
  const symbols = normalizeSymbols(params.symbols);
  return `personalized:${symbols.join("-") || "default"}`;
}

function pageOptions(params: KaiMarketNewsResourceRequest) {
  return {
    cursor: String(params.cursor || "").trim() || null,
    limit: Math.max(1, Math.min(20, Math.trunc(params.limit ?? DEFAULT_LIMIT))),
    daysBack: Math.max(1, Math.min(14, Math.trunc(params.daysBack ?? DEFAULT_DAYS_BACK))),
  };
}

function cacheKeyFor(params: KaiMarketNewsResourceRequest): string {
  const page = pageOptions(params);
  return CACHE_KEYS.KAI_MARKET_NEWS(
    params.userId,
    scopeFor(params),
    page.cursor,
    page.limit,
    page.daysBack,
  );
}

function deviceResourceKeyFor(params: KaiMarketNewsResourceRequest): string {
  const page = pageOptions(params);
  return `kai_market_news:v1:${scopeFor(params)}:${page.daysBack}:${page.cursor || "first"}:${page.limit}`;
}

function log(stage: string, params: KaiMarketNewsResourceRequest, detail?: Record<string, unknown>) {
  logRequestAudit("kai_market_news", stage, {
    mode: params.mode,
    cursor: Boolean(params.cursor),
    ...detail,
  });
}

/**
 * Cache-first resource for the finite Market News feed.
 *
 * The browser caches only returned public headline pages. The server owns the
 * snapshot and cursor, so a click on "Load more" slices cached server data
 * rather than initiating another provider fanout.
 */
export class KaiMarketNewsResourceService {
  static async getStaleFirst(
    params: KaiMarketNewsResourceRequest,
  ): Promise<KaiMarketNewsPage | null> {
    const userId = String(params.userId || "").trim();
    if (!userId) return null;

    const cache = CacheService.getInstance();
    const cacheKey = cacheKeyFor({ ...params, userId });
    const memory = cache.peek<KaiMarketNewsPage>(cacheKey);
    if (!params.forceRefresh && memory?.isFresh) {
      log("cache_hit", params, { tier: "memory" });
      return memory.data;
    }
    if (!params.forceRefresh && memory?.data) {
      log("stale_hit", params, { tier: "memory" });
      if (params.backgroundRefresh !== false) {
        void this.refresh({ ...params, userId }).catch(() => undefined);
      }
      return memory.data;
    }

    if (!params.forceRefresh) {
      const device = await DeviceResourceCacheService.read<KaiMarketNewsPage>({
        userId,
        resourceKey: deviceResourceKeyFor({ ...params, userId }),
      });
      if (device) {
        cache.set(cacheKey, device, CACHE_TTL.MEDIUM);
        log("device_hit", params, { tier: "device" });
        if (params.backgroundRefresh !== false) {
          void this.refresh({ ...params, userId }).catch(() => undefined);
        }
        return device;
      }
    }

    log("cache_miss", params);
    return await this.refresh({ ...params, userId });
  }

  static async refresh(
    params: KaiMarketNewsResourceRequest,
  ): Promise<KaiMarketNewsPage | null> {
    const userId = String(params.userId || "").trim();
    if (!userId) return null;
    const normalized = { ...params, userId };
    const cache = CacheService.getInstance();
    const cacheKey = cacheKeyFor(normalized);
    const inflightKey = cacheKey;
    const existing = inflightRefreshes.get(inflightKey);
    if (existing) {
      log("inflight_dedupe_hit", normalized);
      return await existing;
    }

    const request = (async () => {
      const fallback = cache.peek<KaiMarketNewsPage>(cacheKey)?.data ?? null;
      const page = pageOptions(normalized);
      try {
        const result =
          normalized.mode === "personalized" && normalized.vaultOwnerToken
            ? await ApiService.getKaiMarketNews({
                userId,
                vaultOwnerToken: normalized.vaultOwnerToken,
                symbols: normalizeSymbols(normalized.symbols),
                cursor: page.cursor,
                limit: page.limit,
                daysBack: page.daysBack,
              })
            : await ApiService.getKaiMarketNewsBaseline({
                userId,
                cursor: page.cursor,
                limit: page.limit,
                daysBack: page.daysBack,
              });
        cache.set(cacheKey, result, CACHE_TTL.MEDIUM);
        await DeviceResourceCacheService.write({
          userId,
          resourceKey: deviceResourceKeyFor(normalized),
          value: result,
          ttlMs: DEVICE_TTL_MS,
        });
        log("network_fetch", normalized, { result: "success" });
        return result;
      } catch (error) {
        if (error instanceof MarketNewsSnapshotChangedError) {
          cache.invalidate(cacheKey);
          await DeviceResourceCacheService.invalidateResource(
            userId,
            deviceResourceKeyFor(normalized),
          );
          throw error;
        }
        if (fallback) {
          log("refresh_failure_stale_fallback", normalized);
          return fallback;
        }
        log("network_fetch", normalized, { result: "error" });
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

  static invalidateUser(userId: string): void {
    CacheService.getInstance().invalidatePattern(`kai_market_news_${userId}_`);
  }
}
