"use client";

import { useEffect, useState } from "react";
import { PriceHistoryChart } from "./price-history-chart";
import type { StockPriceHistory } from "@/lib/kai/price-history";
import { Button } from "@/lib/morphy-ux/button";

export type StockHistoryLoader = (symbol: string, signal: AbortSignal) => Promise<StockPriceHistory>;

export function StockHistoryPanel({ symbol, loadHistory, active = true }: {
  symbol: string; loadHistory?: StockHistoryLoader; active?: boolean;
}) {
  const [history, setHistory] = useState<StockPriceHistory | null>(null);
  const [loading, setLoading] = useState(Boolean(active && loadHistory));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setHistory(null);
    setLoading(Boolean(active && loadHistory));
    if (active && loadHistory) void loadHistory(symbol, controller.signal).then(result => {
      if (!controller.signal.aborted) setHistory(result);
    }).catch(() => {
      if (!controller.signal.aborted) setHistory({ points: [], stale: true, retrievedAt: null, unavailableReason: "request_failed" });
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [symbol, active, loadHistory, attempt]);

  if (!active) return null;
  if (loading) return <div role="status" className="flex h-56 items-center justify-center text-sm text-muted-foreground">Loading daily price history…</div>;
  if (!history || history.points.length < 2) return <div className="space-y-2 rounded-xl bg-muted/35 px-4 py-3">
    <p className="text-sm font-medium">Stock price history</p>
    <p className="text-xs leading-[18px] text-muted-foreground">
      {history?.unavailableReason === "unsupported_symbol" ? "Daily price history is not supported for this security."
        : history?.unavailableReason === "insufficient_observations" ? "This source has fewer than two daily prices for this security."
        : !loadHistory ? "Open a signed-in stock view to load its daily prices."
        : "Daily prices couldn’t load. Your current quote and saved holding are still available."}
    </p>
    {loadHistory && history?.unavailableReason !== "unsupported_symbol" ? <Button size="sm" variant="none" effect="fade"
      onClick={() => setAttempt(value => value + 1)}>Retry price history</Button> : null}
  </div>;
  return <div className="space-y-2">
    <PriceHistoryChart key={symbol} data={history.points} label="Price history" />
    <p className="text-xs leading-[18px] text-muted-foreground">
      {[history.source, history.stale ? "Cached history" : history.cached ? "Saved daily history" : "Daily observations",
        history.retrievedAt && Number.isFinite(Date.parse(history.retrievedAt)) ? `Retrieved ${new Date(history.retrievedAt).toLocaleString()}` : null].filter(Boolean).join(" · ")}
    </p>
  </div>;
}
