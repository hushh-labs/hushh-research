import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { ApiService, type KaiHomeInsightsV2 } from "@/lib/services/api-service";
import { CACHE_KEYS } from "@/lib/services/cache-service";

/**
 * The India market view, loaded only while it is the selected market. It has its own
 * cache key and is kept out of the shared US market provider, so US movers, picks and the
 * dashboard KPI that read that provider never see India data.
 */
export function useIndiaMarketHome(userId: string | null | undefined, enabled: boolean) {
  return useStaleResource<KaiHomeInsightsV2 | null>({
    cacheKey: userId ? CACHE_KEYS.KAI_MARKET_HOME_INDIA(userId, 7) : "kai_market_home_india_guest",
    enabled: Boolean(userId) && enabled,
    resourceLabel: "kai_market_home_india",
    cacheTtlMs: 30_000,
    load: async () => (userId ? ApiService.getKaiMarketBaselineInsights({ userId, daysBack: 7, market: "IN" }) : null),
  });
}
