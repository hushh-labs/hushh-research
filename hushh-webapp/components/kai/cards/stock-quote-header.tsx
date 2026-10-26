"use client";

import { useEffect, useState } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import type { KaiHomeRenaissanceItem } from "@/lib/services/api-service";
import type { PublicStockQuote, StockQuoteLoader } from "@/lib/services/public-stock-quote";
import { formatCurrency } from "@/lib/kai/market-value-format";
import { cn } from "@/lib/utils";
import styles from "@/components/kai/shared/finance-workspace.module.css";

const usable = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const timestamp = (value: string | null | undefined) =>
  value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

/** A selected public quote read never derives a spot price from the history chart. */
export function StockQuoteHeader({ row, loadQuote }: {
  row: KaiHomeRenaissanceItem;
  loadQuote?: StockQuoteLoader;
}) {
  const symbol = row.quote_symbol || row.symbol;
  const [quote, setQuote] = useState<PublicStockQuote | null>(null);
  const [loading, setLoading] = useState(Boolean(loadQuote && row.quote_status !== "unsupported"));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setQuote(current => current?.symbol === symbol ? current : null);
    setFailed(false);
    setLoading(Boolean(loadQuote && row.quote_status !== "unsupported"));
    if (loadQuote && row.quote_status !== "unsupported") {
      void loadQuote(symbol, controller.signal)
        .then(result => {
          if (controller.signal.aborted) return;
          if (result?.symbol === symbol && usable(result.price)) setQuote(result);
          else setFailed(true);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }
    return () => controller.abort();
  }, [symbol, loadQuote, row.quote_status, attempt]);
  const recovered = quote?.symbol === symbol && (
    !usable(row.price) || (
      timestamp(quote.quotedAt) > 0 &&
      timestamp(quote.quotedAt) >= timestamp(row.quoted_at)
    )
  ) ? quote : null;
  const price = recovered?.price ?? row.price;
  const change = recovered ? recovered.changePct : row.change_pct;
  const quotedAt = recovered ? recovered.quotedAt : "quoted_at" in row ? row.quoted_at : row.as_of;
  const stale = failed || (recovered ? recovered.stale : row.degraded);
  const delayed = recovered?.delayed;
  const observed = timestamp(quotedAt) ? new Date(quotedAt!).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }) : null;
  const quoteLabel = row.quote_status === "unsupported" ? "Unsupported quote"
    : !usable(price) ? "Quote unavailable"
    : observed ? `Quoted ${observed}` : "Quote time unavailable";
  const freshnessLabel = usable(price) && (stale || delayed)
    ? stale ? " · Cached quote" : " · Delayed" : "";
  return <section aria-label="Stock quote">
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <p className={styles.value}>{usable(price) ? formatCurrency(price) : loading ? "Loading quote…" : "Unavailable"}</p>
      {usable(price) && typeof change === "number" && Number.isFinite(change) ? (
        <p className={cn("text-base font-semibold tabular-nums", change >= 0
          ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
          {change >= 0 ? "+" : ""}{change.toFixed(2)}%
        </p>
      ) : null}
    </div>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs leading-[18px] text-muted-foreground">
      <p>USD · {quoteLabel}{freshnessLabel}</p>
      {failed && loadQuote ? (
        <ShellActionSurface variant="pill" className="h-11 text-xs sm:text-xs" disabled={loading}
          data-voice-control-id="analysis_stock_quote_retry"
          onClick={() => setAttempt(value => value + 1)}>
          Retry quote
        </ShellActionSurface>
      ) : null}
    </div>
  </section>;
}
