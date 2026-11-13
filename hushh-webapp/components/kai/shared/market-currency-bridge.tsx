"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "@/hooks/use-auth";
import { KaiFinancialResourceService } from "@/lib/kai/kai-financial-resource";
import { setMarketCurrencyRate, setMarketCurrencyRegion } from "@/lib/kai/market-currency-store";
import { readSelectedMarketRegion, resolveMarketRegion } from "@/lib/kai/market-region";
import { useMarketCurrency } from "@/lib/kai/use-market-currency";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { ApiService, type KaiUsdInrRate } from "@/lib/services/api-service";
import { CACHE_KEYS } from "@/lib/services/cache-service";

/**
 * Resolves the selected market once for the whole Finance area and publishes it as the
 * currency mode, then loads the daily dollar-to-rupee rate while India is selected. It
 * renders nothing; screens read the mode through `useMarketCurrency`.
 */
export function MarketCurrencyBridge() {
  const { userId, phoneNumber } = useAuth();
  const { region } = useMarketCurrency();
  // Re-read on navigation: the portfolio that implies a market may load after the first paint.
  const pathname = usePathname();

  useEffect(() => {
    if (!userId) {
      setMarketCurrencyRegion(null, "US");
      return;
    }
    const resolved = resolveMarketRegion({
      selected: readSelectedMarketRegion(userId),
      holdings: KaiFinancialResourceService.peek(userId)?.data?.activePortfolio?.holdings,
      phoneNumber,
      localeTag: typeof navigator === "undefined" ? null : navigator.language,
    });
    setMarketCurrencyRegion(userId, resolved.region);
  }, [pathname, phoneNumber, userId]);

  const rate = useStaleResource<KaiUsdInrRate | null>({
    cacheKey: userId ? CACHE_KEYS.KAI_MARKET_FX_USD_INR(userId) : "kai_market_fx_usd_inr_guest",
    enabled: Boolean(userId) && region === "IN",
    resourceLabel: "kai_market_fx_usd_inr",
    load: async () => (userId ? ApiService.getKaiUsdInrRate({ userId }) : null),
  });

  useEffect(() => {
    // No rate (provider down, nothing cached) leaves dollars on screen rather than a guess.
    setMarketCurrencyRate(
      region === "IN" && rate.data
        ? { rate: rate.data.rate, asOf: rate.data.as_of, stale: rate.data.stale }
        : null,
    );
  }, [rate.data, region]);

  return null;
}
