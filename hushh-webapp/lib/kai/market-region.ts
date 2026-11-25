import { resolveContactPhoneRegion } from "@/lib/contacts/phone-normalization";

/** Markets the Finance Market tab can show. Anything else falls back to US. */
export type MarketRegion = "US" | "IN";

export type MarketRegionSource = "selected" | "portfolio" | "account" | "device" | "default";

type HoldingLike = {
  symbol?: string | null;
  currency?: string | null;
  iso_currency_code?: string | null;
};

const STORAGE_PREFIX = "kai_market_region_v1";

export function isMarketRegion(value: unknown): value is MarketRegion {
  return value === "US" || value === "IN";
}

const storageKey = (userId: string) => `${STORAGE_PREFIX}:${userId}`;

export function readSelectedMarketRegion(userId: string | null | undefined): MarketRegion | null {
  if (!userId || typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(storageKey(userId));
    return isMarketRegion(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeSelectedMarketRegion(userId: string | null | undefined, region: MarketRegion): void {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(userId), region);
  } catch {
    /* A blocked store only means the choice is not remembered next visit. */
  }
}

function holdingIsIndian(holding: HoldingLike): boolean {
  const currency = String(holding.iso_currency_code || holding.currency || "").toUpperCase();
  if (currency === "INR") return true;
  return /\.(NS|BO)$/i.test(String(holding.symbol || "").trim());
}

/** The market most of the portfolio trades in, or null with no holdings to judge by. */
export function marketFromHoldings(holdings: readonly HoldingLike[] | null | undefined): MarketRegion | null {
  const rows = (holdings ?? []).filter((holding) => String(holding.symbol || "").trim());
  if (!rows.length) return null;
  return rows.filter(holdingIsIndian).length * 2 > rows.length ? "IN" : "US";
}

const toMarket = (country: string | null | undefined): MarketRegion | null =>
  country ? (country.toUpperCase() === "IN" ? "IN" : "US") : null;

/** Region of the signed-in account's own verified phone number. */
export function marketFromAccountPhone(phoneNumber: string | null | undefined): MarketRegion | null {
  return toMarket(resolveContactPhoneRegion({ accountPhoneNumber: phoneNumber, allowLocaleFallback: false }));
}

/** Region of the device language, never its location. */
export function marketFromDeviceLocale(localeTag: string | null | undefined): MarketRegion | null {
  if (!localeTag) return null;
  try {
    return toMarket(new Intl.Locale(localeTag).maximize().region);
  } catch {
    return null;
  }
}

/**
 * Selected market, then the portfolio's market, then the account's region, then the
 * device language, else US. A GPS fix is deliberately not a signal: travelling does
 * not change which market a person follows.
 */
export function resolveMarketRegion(signals: {
  selected?: MarketRegion | null;
  holdings?: readonly HoldingLike[] | null;
  phoneNumber?: string | null;
  localeTag?: string | null;
}): { region: MarketRegion; source: MarketRegionSource } {
  if (signals.selected) return { region: signals.selected, source: "selected" };
  const portfolio = marketFromHoldings(signals.holdings);
  if (portfolio) return { region: portfolio, source: "portfolio" };
  const account = marketFromAccountPhone(signals.phoneNumber);
  if (account) return { region: account, source: "account" };
  const device = marketFromDeviceLocale(signals.localeTag);
  if (device) return { region: device, source: "device" };
  return { region: "US", source: "default" };
}
