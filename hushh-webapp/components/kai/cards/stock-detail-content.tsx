"use client";

import { useEffect, useState } from "react";
import { PriceHistoryChart } from "@/components/kai/charts/price-history-chart";
import { RenaissanceVerdictCard } from "@/components/kai/cards/renaissance-verdict-card";
import type { KaiHomeRenaissanceItem, KaiMarketCompanyFacts } from "@/lib/services/api-service";
import type { StockPriceHistory } from "@/lib/kai/price-history";
import { cn } from "@/lib/utils";
import { SectionLabel } from "@/components/app-ui/typography";
import styles from "@/components/kai/shared/finance-workspace.module.css";

export type StockHistoryLoader = (symbol: string, signal: AbortSignal) => Promise<StockPriceHistory>;
const money = (value: number | null | undefined, compact = false) => typeof value === "number" && Number.isFinite(value)
  ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: compact ? "compact" : "standard", maximumFractionDigits: 2 }).format(value) : "Unavailable";
const ratio = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}×` : "Unavailable";
const asOf = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Unavailable";

/** The shared sheet owns focus/dismissal; this body owns only the selected quote. */
export function StockDetailContent({ row, facts, loadHistory }: {
  row: KaiHomeRenaissanceItem; facts?: KaiMarketCompanyFacts; loadHistory?: StockHistoryLoader;
}) {
  const symbol = row.quote_symbol || row.symbol;
  const [history, setHistory] = useState<StockPriceHistory | null>(null);
  const [loading, setLoading] = useState(Boolean(loadHistory));
  useEffect(() => {
    const controller = new AbortController();
    setHistory(null);
    setLoading(Boolean(loadHistory));
    if (loadHistory) void loadHistory(symbol, controller.signal).then(points => {
      if (!controller.signal.aborted) setHistory(points);
    }).catch(() => { /* The quote and company facts remain available. */ }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [symbol, loadHistory]);
  const change = row.change_pct;
  const financialFacts = [
    ["Market cap", money(facts?.market_cap ?? row.market_cap, true)],
    ["P/E (TTM)", ratio(facts?.pe_ratio)],
    ["P/B", ratio(facts?.pb_ratio)],
    ["Debt / equity", ratio(facts?.debt_to_equity)],
    ["List free cash flow", typeof row.fcf_billions === "number" ? `$${row.fcf_billions.toFixed(1)}B` : "Unavailable"],
    ["Financial period end", facts?.financial_period_end || "Unavailable"],
  ];
  return <div className={cn(styles.detail, "space-y-6")}>
    <div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className={styles.value}>{money(row.price)}</p>
        {typeof change === "number" && Number.isFinite(change) ? <p className={cn("text-base font-semibold tabular-nums", change >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</p> : null}
      </div>
      <p className="mt-2 text-xs leading-[18px] text-muted-foreground">USD · {row.quote_status === "unsupported" ? "Unsupported quote" : `Quoted ${asOf(row.as_of)}`}{row.degraded ? " · Delayed" : ""}</p>
    </div>
    {loading ? <div role="status" className="flex h-64 items-center justify-center text-sm text-muted-foreground">Loading price history…</div>
      : <div className="space-y-2"><PriceHistoryChart key={symbol} data={history?.points ?? []} label="Price history" />
          {history?.points.length ? <p className="text-xs leading-[18px] text-muted-foreground">{history.stale ? "Cached history" : "Daily observations"}{history.retrievedAt ? ` · Retrieved ${asOf(history.retrievedAt)}` : ""}</p> : null}</div>}
    <section aria-label="Company facts">
      <SectionLabel role="heading" aria-level={3}>Company facts</SectionLabel>
      <dl className={styles.facts}>{financialFacts.map(([label, value]) => <div key={label} className={styles.fact}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="mt-3 text-xs leading-[18px] text-muted-foreground">{facts?.source || "Financial source unavailable"}{facts?.retrieved_at ? ` · Retrieved ${asOf(facts.retrieved_at)}` : ""}{facts?.stale ? " · Cached" : ""}{facts?.ratio_basis ? ` · ${facts.ratio_basis}` : ""}</p>
    </section>
    <RenaissanceVerdictCard row={{ ...row, company_facts: facts }} />
  </div>;
}
