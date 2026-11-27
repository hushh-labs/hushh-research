import { getMarketCurrencySnapshot, type MarketCurrencyMode } from "@/lib/kai/market-currency-store";

export type MoneyFormatOptions = {
  /** Currency the value is held in. Defaults to USD, the currency of most Finance data. */
  source?: string | null;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  notation?: "standard" | "compact";
  signDisplay?: Intl.NumberFormatOptions["signDisplay"];
};

const normalizeCurrency = (currency: string | null | undefined): string =>
  currency && /^[a-z]{3}$/i.test(currency) ? currency.toUpperCase() : "USD";

/**
 * The currency a value is shown in. Only dollars convert, and only in India mode with a
 * known rate: a value already in rupees (an NSE quote) is never converted again, and in
 * US mode every value keeps its own currency. Without a rate it stays in dollars, because
 * a guessed rate would be a made-up number.
 */
export function resolveDisplayMoney(
  value: number,
  source: string | null | undefined,
  mode: MarketCurrencyMode,
): { amount: number; currency: string; locale: "en-US" | "en-IN" } {
  const from = normalizeCurrency(source);
  if (mode.region === "IN" && from === "USD" && mode.rate && mode.rate > 0) {
    return { amount: value * mode.rate, currency: "INR", locale: "en-IN" };
  }
  return { amount: value, currency: from, locale: mode.region === "IN" && from === "INR" ? "en-IN" : "en-US" };
}

/** Formats a money value for the given market mode. US output is the en-US dollar format. */
export function formatMoney(
  value: number | null | undefined,
  mode: MarketCurrencyMode,
  options: MoneyFormatOptions = {},
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Price unavailable";
  const { amount, currency, locale } = resolveDisplayMoney(value, options.source, mode);
  const compact = options.notation === "compact";
  const format: Intl.NumberFormatOptions = { style: "currency", currency };
  if (compact) format.notation = "compact";
  if (options.minimumFractionDigits !== undefined) format.minimumFractionDigits = options.minimumFractionDigits;
  format.maximumFractionDigits = options.maximumFractionDigits ?? (compact ? 1 : 2);
  if (options.signDisplay) format.signDisplay = options.signDisplay;
  return new Intl.NumberFormat(locale, format).format(amount);
}

/** Display-currency money for the selected market, outside React. Components use `useMarketCurrency`. */
export function formatCurrency(value: number | null | undefined, currency = "USD"): string {
  return formatMoney(value, getMarketCurrencySnapshot(), { source: currency });
}

/** Whole-unit money, no cents: the format summary strips and projections use. */
export function formatCurrencyWhole(value: number | null | undefined, currency = "USD"): string {
  return formatMoney(value, getMarketCurrencySnapshot(), { source: currency, maximumFractionDigits: 0 });
}

/** Any money format the presets do not cover, for the selected market (outside React). */
export function formatDisplayMoney(value: number | null | undefined, options: MoneyFormatOptions = {}): string {
  return formatMoney(value, getMarketCurrencySnapshot(), options);
}

/** Compact from one million, whole units below: the allocation bars' format. */
export function formatCurrencyAdaptive(value: number, currency = "USD"): string {
  const compact = value >= 1_000_000;
  return formatMoney(value, getMarketCurrencySnapshot(), {
    source: currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 0,
  });
}

type ShortSuffix = "Cr" | "L" | "M" | "K";

export type MoneyShortOptions = {
  /** Decimals per suffix. Defaults: 1 for Cr, L and M; 0 for K. */
  digits?: Partial<Record<ShortSuffix, number>>;
  /** Amounts under one thousand: whole units (default) or with cents. */
  below?: "whole" | "cents";
};

/**
 * Abbreviated money: $12K, $1.2M in dollars; ₹88K, ₹1.2L, ₹8.9Cr in rupees. Hand-built so
 * the suffixes do not depend on the browser's ICU data.
 */
export function formatMoneyShort(
  value: number,
  mode: MarketCurrencyMode,
  source: string | null | undefined = "USD",
  options: MoneyShortOptions = {},
): string {
  if (!Number.isFinite(value)) return "Price unavailable";
  const { amount, currency } = resolveDisplayMoney(value, source, mode);
  const symbol = currency === "INR" ? "₹" : "$";
  const units: [number, ShortSuffix][] =
    currency === "INR" ? [[1e7, "Cr"], [1e5, "L"], [1e3, "K"]] : [[1e6, "M"], [1e3, "K"]];
  for (const [size, suffix] of units) {
    if (Math.abs(amount) >= size) {
      const digits = options.digits?.[suffix] ?? (suffix === "K" ? 0 : 1);
      return `${symbol}${(amount / size).toFixed(digits)}${suffix}`;
    }
  }
  return options.below === "cents"
    ? formatMoney(value, mode, { source, minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : `${symbol}${amount.toFixed(0)}`;
}

export function formatCurrencyShort(
  value: number,
  currency = "USD",
  options: MoneyShortOptions = {},
): string {
  return formatMoneyShort(value, getMarketCurrencySnapshot(), currency, options);
}

export function formatCompactNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  return formatMoney(value, getMarketCurrencySnapshot(), { notation: "compact", maximumFractionDigits: 1 });
}
