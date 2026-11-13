import { storeSelectedMarketRegion, type MarketRegion } from "@/lib/kai/market-region";

/** What the formatter needs: the selected market and, in India mode, rupees per dollar. */
export type MarketCurrencyMode = {
  region: MarketRegion;
  rate: number | null;
};

export type MarketCurrencyState = MarketCurrencyMode & {
  /** Day the rate was quoted, shown beside converted figures. */
  rateAsOf: string | null;
  rateStale: boolean;
};

const US_MODE: MarketCurrencyState = Object.freeze({ region: "US", rate: null, rateAsOf: null, rateStale: false });

let state: MarketCurrencyState = US_MODE;
let currentUserId: string | null = null;
const listeners = new Set<() => void>();

function publish(next: MarketCurrencyState) {
  if (
    next.region === state.region &&
    next.rate === state.rate &&
    next.rateAsOf === state.rateAsOf &&
    next.rateStale === state.rateStale
  ) {
    return;
  }
  state = next;
  listeners.forEach((listener) => listener());
}

export const subscribeMarketCurrency = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const getMarketCurrencySnapshot = (): MarketCurrencyState => state;
export const getServerMarketCurrencySnapshot = (): MarketCurrencyState => US_MODE;

/** Called by the Finance bridge once the account's market is resolved. */
export function setMarketCurrencyRegion(userId: string | null, region: MarketRegion) {
  currentUserId = userId;
  publish({ ...state, region, ...(region === "US" ? { rate: null, rateAsOf: null, rateStale: false } : {}) });
}

/** The person's choice on the Market page: remembered per account and applied everywhere. */
export function chooseMarketCurrencyRegion(region: MarketRegion) {
  storeSelectedMarketRegion(currentUserId, region);
  setMarketCurrencyRegion(currentUserId, region);
}

export function setMarketCurrencyRate(rate: { rate: number; asOf: string | null; stale: boolean } | null) {
  const usable = rate && Number.isFinite(rate.rate) && rate.rate > 0 ? rate : null;
  publish({ ...state, rate: usable?.rate ?? null, rateAsOf: usable?.asOf ?? null, rateStale: Boolean(usable?.stale) });
}

/** Test helper: back to the default US mode with no user. */
export function resetMarketCurrency() {
  currentUserId = null;
  publish(US_MODE);
}
