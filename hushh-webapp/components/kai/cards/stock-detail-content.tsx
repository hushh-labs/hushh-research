"use client";

import { useEffect, useState } from "react";
import { StockHistoryPanel, type StockHistoryLoader } from "@/components/kai/charts/stock-history-panel";
import { RenaissanceVerdictCard } from "@/components/kai/cards/renaissance-verdict-card";
import type { KaiHomeNewsItem, KaiHomeRenaissanceItem, KaiMarketCompanyFacts } from "@/lib/services/api-service";
import { cn } from "@/lib/utils";
import { OneMarketNewsCover } from "@/components/kai/cards/market-news-briefing";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import { SectionLabel } from "@/components/app-ui/typography";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import { StockQuoteHeader } from "./stock-quote-header";
import type { StockQuoteLoader } from "@/lib/services/public-stock-quote";

import { formatDisplayMoney } from "@/lib/kai/market-value-format";
import { useMarketCurrency } from "@/lib/kai/use-market-currency";
export type { StockHistoryLoader } from "@/components/kai/charts/stock-history-panel";
const money = (value: number | null | undefined, compact = false) => typeof value === "number" && Number.isFinite(value)
  ? formatDisplayMoney(value, { notation: compact ? "compact" : "standard", maximumFractionDigits: 2 }) : "Unavailable";
const ratio = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}×` : "Unavailable";
const asOf = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Unavailable";

/** The shared sheet owns focus/dismissal; this body owns only the selected quote. */
export function StockDetailContent({ row, facts, loadHistory, loadQuote, news = [], loadCompanyNews, market = "US", marketMover = false }: {
  row: KaiHomeRenaissanceItem; facts?: KaiMarketCompanyFacts; loadHistory?: StockHistoryLoader; loadQuote?: StockQuoteLoader; news?: KaiHomeNewsItem[];
  loadCompanyNews?: (symbol: string, signal: AbortSignal) => Promise<KaiHomeNewsItem[]>;
  market?: "US" | "IN"; marketMover?: boolean;
}) {
  useMarketCurrency();
  const symbol = row.quote_symbol || row.symbol;
  const [loadedNews, setLoadedNews] = useState<KaiHomeNewsItem[] | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsError, setNewsError] = useState(false);
  useEffect(() => {
    if (!loadCompanyNews) return;
    const controller = new AbortController();
    setLoadedNews(null); setNewsLoading(true); setNewsError(false);
    void loadCompanyNews(symbol, controller.signal).then(items => {
      if (!controller.signal.aborted) setLoadedNews(items);
    }).catch(() => { if (!controller.signal.aborted) setNewsError(true); })
      .finally(() => { if (!controller.signal.aborted) setNewsLoading(false); });
    return () => controller.abort();
  }, [symbol, loadCompanyNews]);
  const companyNews = (loadedNews ?? news).filter(item => [row.symbol, row.quote_symbol].some(ticker => ticker && ticker.toUpperCase() === item.symbol.trim().toUpperCase()) && /^https?:\/\//i.test(item.url)).slice(0, 15);
  const financialFacts = [
    ["Market cap", money(facts?.market_cap ?? row.market_cap, true)],
    ...(!marketMover ? [["List tier", row.tier || "Unavailable"]] : []),
    ["P/E (TTM)", ratio(facts?.pe_ratio)],
    ["P/B", ratio(facts?.pb_ratio)],
    ["Debt / equity", ratio(facts?.debt_to_equity)],
    ...(!marketMover ? [["List free cash flow", typeof row.fcf_billions === "number" ? `$${row.fcf_billions.toFixed(1)}B` : "Unavailable"]] : []),
    ["Financial period end", facts?.financial_period_end || "Unavailable"],
  ];
  return <div className={cn(styles.detail, "space-y-6")}>
    <StockQuoteHeader row={row} loadQuote={loadQuote} currency={market === "IN" ? "INR" : "USD"} />
    <StockHistoryPanel symbol={symbol} loadHistory={loadHistory} market={market} />
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
        <div className="min-w-0 flex-1"><p className="text-sm font-medium leading-[21px]">{item.title}</p><p className="mt-1 text-xs leading-[18px] text-muted-foreground">{item.source_name} · {asOf(item.published_at)}</p>{item.summary ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.summary}</p> : null}</div>
        <OneMarketNewsCover row={item} index={index} thumbnail className="h-16 w-16 shrink-0 rounded-lg" />
      </button>)}</div> : <p className={styles.description}>{newsLoading ? "Loading company news…" : newsError ? "Company news is temporarily unavailable." : "No company headlines are available."}</p>}
    </section>
  </div>;
}
