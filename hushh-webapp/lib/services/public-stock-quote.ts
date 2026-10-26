import { ApiService } from "@/lib/services/api-service";

export interface PublicStockQuote {
  symbol: string;
  price: number;
  changePct: number | null;
  quotedAt: string | null;
  source: string | null;
  stale: boolean;
  delayed: boolean;
}
export type StockQuoteLoader = (symbol: string, signal: AbortSignal) => Promise<PublicStockQuote | null>;

/** Selected symbol only. The existing public backend cache owns session policy. */
export const loadPublicStockQuote: StockQuoteLoader = async (symbol, signal) => {
  if (!/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol)) return null;
  const response = await ApiService.apiFetch(
    `/api/market/quotes?${new URLSearchParams({ symbols: symbol })}`,
    { signal },
  );
  if (!response.ok) throw new Error("Quote unavailable");
  const payload = await response.json() as { quotes?: Array<Record<string, unknown>> };
  const row = Array.isArray(payload.quotes)
    ? payload.quotes.find(item => item?.symbol === symbol)
    : null;
  if (!row || typeof row.price !== "number" || !Number.isFinite(row.price) || row.price <= 0) {
    return null;
  }
  return {
    symbol,
    price: row.price,
    changePct: typeof row.change_pct === "number" && Number.isFinite(row.change_pct) ? row.change_pct : null,
    quotedAt: typeof row.quoted_at === "string" && Number.isFinite(Date.parse(row.quoted_at)) ? row.quoted_at : null,
    source: typeof row.source === "string" ? row.source : null,
    stale: row.is_stale === true,
    delayed: row.is_delayed === true,
  };
};
