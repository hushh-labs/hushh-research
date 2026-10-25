"use client";

import { StockHistoryPanel, type StockHistoryLoader } from "@/components/kai/charts/stock-history-panel";
import { RenaissanceVerdictCard } from "@/components/kai/cards/renaissance-verdict-card";
import type { KaiHomeNewsItem, KaiHomeRenaissanceItem, KaiMarketCompanyFacts } from "@/lib/services/api-service";
import { cn } from "@/lib/utils";
import { OneMarketNewsCover } from "@/components/kai/cards/market-news-briefing";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import { SectionLabel } from "@/components/app-ui/typography";
import styles from "@/components/kai/shared/finance-workspace.module.css";

export type { StockHistoryLoader } from "@/components/kai/charts/stock-history-panel";
const money = (value: number | null | undefined, compact = false) => typeof value === "number" && Number.isFinite(value)
  ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: compact ? "compact" : "standard", maximumFractionDigits: 2 }).format(value) : "Unavailable";
const ratio = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}×` : "Unavailable";
const asOf = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Unavailable";

/** The shared sheet owns focus/dismissal; this body owns only the selected quote. */
export function StockDetailContent({ row, facts, loadHistory, news = [] }: {
  row: KaiHomeRenaissanceItem; facts?: KaiMarketCompanyFacts; loadHistory?: StockHistoryLoader; news?: KaiHomeNewsItem[];
}) {
  const symbol = row.quote_symbol || row.symbol;
  const companyNews = news.filter(item => [row.symbol, row.quote_symbol].some(ticker => ticker && ticker.toUpperCase() === item.symbol.trim().toUpperCase()) && /^https?:\/\//i.test(item.url)).slice(0, 4);
  const change = row.change_pct;
  const financialFacts = [
    ["Market cap", money(facts?.market_cap ?? row.market_cap, true)],
    ["List tier", row.tier || "Unavailable"],
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
    <StockHistoryPanel symbol={symbol} loadHistory={loadHistory} />
    <section aria-label="Company facts">
      <SectionLabel role="heading" aria-level={3}>Company facts</SectionLabel>
      <dl className={styles.facts}>{financialFacts.map(([label, value]) => <div key={label} className={styles.fact}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="mt-3 text-xs leading-[18px] text-muted-foreground">{facts?.source || "Financial source unavailable"}{facts?.retrieved_at ? ` · Retrieved ${asOf(facts.retrieved_at)}` : ""}{facts?.stale ? " · Cached" : ""}{facts?.ratio_basis ? ` · ${facts.ratio_basis}` : ""}</p>
    </section>
    <RenaissanceVerdictCard row={{ ...row, company_facts: facts }} />
    <section aria-label="Company news" className="space-y-3">
      <SectionLabel role="heading" aria-level={3}>Company news</SectionLabel>
      {companyNews.length ? <div className="divide-y divide-border">{companyNews.map((item, index) => <button key={item.url} type="button"
        className="flex min-h-14 w-full items-start gap-3 py-4 text-left focus-visible:outline-2 focus-visible:outline-ring" onClick={() => openExternalUrl(item.url)}>
        <div className="min-w-0 flex-1"><p className="text-sm font-medium leading-[21px]">{item.title}</p><p className="mt-1 text-xs leading-[18px] text-muted-foreground">{item.source_name} · {asOf(item.published_at)}</p></div>
        <OneMarketNewsCover row={item} index={index} thumbnail className="h-16 w-16 shrink-0 rounded-lg" />
      </button>)}</div> : <p className={styles.description}>No company headlines are available from the current news feed.</p>}
    </section>
  </div>;
}
