"use client";

import { useMemo, useSyncExternalStore } from "react";

import {
  chooseMarketCurrencyRegion,
  getMarketCurrencySnapshot,
  getServerMarketCurrencySnapshot,
  subscribeMarketCurrency,
} from "@/lib/kai/market-currency-store";
import { formatMoney, type MoneyFormatOptions } from "@/lib/kai/market-value-format";

/**
 * The selected market as a currency mode for every Finance screen: `region` US shows
 * dollars, IN shows rupees converted at the daily rate. One mode, no extra switch.
 */
export function useMarketCurrency() {
  const state = useSyncExternalStore(
    subscribeMarketCurrency,
    getMarketCurrencySnapshot,
    getServerMarketCurrencySnapshot,
  );
  return useMemo(() => {
    const converting = state.region === "IN" && Boolean(state.rate);
    return {
      region: state.region,
      /** Currency dollar amounts are shown in. */
      currency: converting ? ("INR" as const) : ("USD" as const),
      rate: state.rate,
      rateAsOf: state.rateAsOf,
      rateStale: state.rateStale,
      format: (value: number | null | undefined, options?: MoneyFormatOptions) =>
        formatMoney(value, state, options),
      formatCompact: (value: number | null | undefined, options?: Omit<MoneyFormatOptions, "notation">) =>
        formatMoney(value, state, { ...options, notation: "compact" }),
      selectRegion: chooseMarketCurrencyRegion,
    };
  }, [state]);
}
