import { normalizePriceHistory, type StockPriceHistory } from "@/lib/kai/price-history";

export async function readKaiStockHistory(userId: string, symbol: string, token: string,
  apiFetch: (path: string, options: RequestInit) => Promise<Response>, signal?: AbortSignal): Promise<StockPriceHistory> {
  const query = new URLSearchParams({ symbol });
  const response = await apiFetch(`/api/kai/market/history/${encodeURIComponent(userId)}?${query}`, {
    signal, headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 422) return { points: [], stale: true, retrievedAt: null, unavailableReason: "unsupported_symbol" };
  if (!response.ok) throw new Error("Price history could not load");
  const payload = await response.json() as { points?: Array<{ t: number; p: number }>; stale?: boolean; retrieved_at?: string | null; source?: string; cached?: boolean; unavailable_reason?: StockPriceHistory["unavailableReason"] };
  const points = (Array.isArray(payload.points) ? payload.points : []).filter(point =>
    point && Number.isFinite(point.t) && Number.isFinite(point.p) && point.p > 0 &&
    Number.isFinite(new Date(point.t * 1000).getTime()));
  return { points: normalizePriceHistory(points.map(point => ({ date: new Date(point.t * 1000).toISOString(), value: point.p }))),
    stale: payload.stale === true, retrievedAt: payload.retrieved_at ?? null,
    source: payload.source, cached: payload.cached === true, unavailableReason: payload.unavailable_reason };
}
