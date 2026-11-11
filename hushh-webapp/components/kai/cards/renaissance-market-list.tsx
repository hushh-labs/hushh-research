"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";


import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { StockDetailContent, type StockHistoryLoader } from "@/components/kai/cards/stock-detail-content";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import { StockListToolbar } from "@/components/kai/cards/stock-list-toolbar";
import { useIsMobile } from "@/hooks/use-mobile";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Button } from "@/components/ui/button";
import { SettingsGroup } from "@/components/profile/settings-ui";
import { marketSettingsGroupClassName } from "@/components/kai/shared/market-surface-theme";
import type {
  KaiHomeNewsItem,
  KaiHomePickSource,
  KaiHomeRenaissanceItem,
  KaiMarketCompanyFacts,
} from "@/lib/services/api-service";
import { cn } from "@/lib/utils";
import { formatCurrency, formatCompactNumber } from "@/lib/kai/market-value-format";
import type { StockQuoteLoader } from "@/lib/services/public-stock-quote";



const ALL_FILTER = "all";
// One continuous list: this many companies show first, and the next batch is
// added as the end of the list nears the screen. Company facts load for the
// rows shown, so a long list never asks the data provider for everything at once.
const PICKS_BATCH_SIZE = 24;



function rowSearchText(row: KaiHomeRenaissanceItem): string {
  return [
    row.symbol,
    row.quote_symbol,
    row.company_name,
    row.sector,
    row.tier,
    row.investment_thesis,
    row.recommendation_bias,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function mergeMarketCompanyFacts(
  current: Record<string, KaiMarketCompanyFacts>,
  incoming: Record<string, KaiMarketCompanyFacts>,
  rows: KaiHomeRenaissanceItem[],
): Record<string, KaiMarketCompanyFacts> {
  const merged = { ...current };
  for (const [symbol, facts] of Object.entries(incoming)) {
    const previous = current[symbol] || rows.find((row) => (row.quote_symbol || row.symbol) === symbol)?.company_facts;
    merged[symbol] = facts.unavailable && previous && !previous.unavailable
      ? { ...previous, stale: true }
      : facts;
  }
  return merged;
}

export function RiaPicksList({
  rows = [],
  sources = [],
  activeSourceId = "default",
  onSourceChange,
  controlMode = "inline",
  loadCompanyFacts,
  onAnalyze,
  onSelectedSymbolChange,
  loadHistory,
  loadQuote,
  toolbarActions,
  news = [],
}: {
  rows?: KaiHomeRenaissanceItem[];
  sources?: KaiHomePickSource[];
  activeSourceId?: string;
  onSourceChange?: (sourceId: string) => void;
  controlMode?: "inline" | "adaptive-surface";
  loadCompanyFacts?: (symbols: string[]) => Promise<Record<string, KaiMarketCompanyFacts>>;
  onAnalyze?: (symbol: string) => void;
  onSelectedSymbolChange?: (symbol: string | null) => void;
  loadHistory?: StockHistoryLoader;
  loadQuote?: StockQuoteLoader;
  toolbarActions?: ReactNode;
  news?: KaiHomeNewsItem[];
}) {
  const isMobile = useIsMobile();
  void controlMode;
  const [selectedSeed, setSelectedRow] = useState<KaiHomeRenaissanceItem | null>(
    null,
  );
  const selectedRow = selectedSeed ? rows.find(row =>
    (row.quote_symbol || row.symbol) === (selectedSeed.quote_symbol || selectedSeed.symbol)) || selectedSeed : null;
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<string>(ALL_FILTER);
  const [sectorFilter, setSectorFilter] = useState<string>(ALL_FILTER);
  const [visibleCount, setVisibleCount] = useState(PICKS_BATCH_SIZE);
  const endOfList = useRef<HTMLDivElement>(null);
  const [factsBySymbol, setFactsBySymbol] = useState<Record<string, KaiMarketCompanyFacts>>({});

  useEffect(() => {
    onSelectedSymbolChange?.(selectedRow?.symbol ?? null);
    return () => onSelectedSymbolChange?.(null);
  }, [onSelectedSymbolChange, selectedRow?.symbol]);


  const availableSources = useMemo<KaiHomePickSource[]>(
    () =>
      sources.length > 0
        ? sources
        : [
            {
              id: "default",
              label: "Default list",
              kind: "default",
              state: "ready",
              is_default: true,
            },
          ],
    [sources],
  );

  const activeSource = useMemo(
    () =>
      availableSources.find((source) => source.id === activeSourceId) ??
      availableSources[0] ??
      null,
    [activeSourceId, availableSources],
  );

  const sectors = useMemo(
    () =>
      [
        ...new Set(
          rows.map((row) => String(row.sector || "").trim()).filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesTier =
        tierFilter === ALL_FILTER ||
        String(row.tier || "")
          .trim()
          .toUpperCase() === tierFilter;
      const matchesSector =
        sectorFilter === ALL_FILTER ||
        String(row.sector || "").trim() === sectorFilter;
      const matchesQuery =
        !normalizedQuery || rowSearchText(row).includes(normalizedQuery);
      return matchesTier && matchesSector && matchesQuery;
    });
  }, [query, rows, sectorFilter, tierFilter]);

  useEffect(() => {
    setVisibleCount(PICKS_BATCH_SIZE);
  }, [activeSourceId, query, sectorFilter, tierFilter]);

  const hasMoreRows = visibleCount < filteredRows.length;
  const canObserve = typeof IntersectionObserver !== "undefined";
  useEffect(() => {
    const end = endOfList.current;
    if (!hasMoreRows || !end || !canObserve) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) => count + PICKS_BATCH_SIZE);
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [canObserve, hasMoreRows, visibleCount]);

  const currentPageRows = useMemo(
    () => filteredRows.slice(0, visibleCount),
    [filteredRows, visibleCount],
  );
  const visibleSymbolsKey = currentPageRows.map((row) => row.quote_symbol || row.symbol).join(",");
  useEffect(() => {
    if (!loadCompanyFacts || !visibleSymbolsKey) return;
    let cancelled = false;
    const symbols = visibleSymbolsKey.split(",");
    void loadCompanyFacts(symbols).then((facts) => {
      if (!cancelled) setFactsBySymbol((current) => mergeMarketCompanyFacts(current, facts, rows));
    }).catch(() => {
      if (!cancelled) setFactsBySymbol((current) => mergeMarketCompanyFacts(current, Object.fromEntries(symbols.map((symbol) => [symbol, { symbol, unavailable: true }])), rows));
    });
    return () => { cancelled = true; };
  }, [loadCompanyFacts, visibleSymbolsKey, rows]);
  const selectedFacts = selectedRow ? factsBySymbol[selectedRow.quote_symbol || selectedRow.symbol] || selectedRow.company_facts : undefined;

  return (
    <div className={cn(styles.detail, "space-y-4")}>
      <StockListToolbar query={query} setQuery={setQuery} tier={tierFilter} setTier={setTierFilter}
        sector={sectorFilter} setSector={setSectorFilter} sectors={sectors}
        sources={availableSources} activeSource={activeSource?.id || "default"} onSourceChange={onSourceChange} actions={toolbarActions} />
      <h2 className="ui-text-section-label">Companies</h2>
      <SettingsGroup className={marketSettingsGroupClassName}>
        {filteredRows.length === 0 ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">
            {rows.length ? "No stocks match the current filters." : `No stocks are available in ${activeSource?.label || "this list"}.`}
          </div>
        ) : (
          <div
            className={cn(styles.stockRows, "touch-pan-y")}
            data-no-route-swipe
          >
            {currentPageRows.map((row) => {
              const changePct =
                typeof row.change_pct === "number" &&
                Number.isFinite(row.change_pct)
                  ? row.change_pct
                  : null;
              const cap = factsBySymbol[row.quote_symbol || row.symbol]?.market_cap ?? row.company_facts?.market_cap ?? row.market_cap;
              const capLabel = typeof cap === "number" && cap > 0 ? `${formatCompactNumber(cap)} cap` : "Cap unavailable";

              const selected = selectedRow?.symbol === row.symbol && selectedRow?.tier === row.tier;
              return (
                <button
                  key={`${row.symbol}-${row.tier || "tierless"}`}
                  type="button"
                  data-testid="market-pick-row"
                  data-finance-selected={selected || undefined}
                  aria-haspopup="dialog"
                  aria-expanded={selected}
                  data-no-route-swipe
                  onClick={() => setSelectedRow(row)}
                  className={cn(
                    styles.interactiveRow,
                    "group relative isolate flex w-full items-center gap-3 border-t border-border/60 px-4 py-4 text-left first:border-t-0",
                  )}
                >
                  <div className="shrink-0">
                    <SymbolAvatar
                      symbol={String(row.quote_symbol || row.symbol || "—")}
                      name={row.company_name}
                      size="md"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p data-stock-name className="text-sm font-semibold text-foreground">{row.symbol}</p>
                    <p data-stock-meta className="mt-1 text-xs leading-[18px] text-muted-foreground">{row.company_name || row.symbol}</p>
                    <p data-stock-meta className="mt-1 flex flex-wrap gap-x-2 text-xs leading-[18px] text-muted-foreground">
                      {row.sector ? <span>{row.sector}</span> : null}
                      <span>{row.tier || "CORE"}</span><span>{capLabel}</span>
                      {row.degraded ? <span>Delayed</span> : null}
                    </p>
                  </div>
                  <div
                    className={cn(
                      "shrink-0 text-right tabular-nums",
                      isMobile ? "min-w-[5.25rem]" : "",
                    )}
                  >
                    <p className="text-sm font-semibold tabular-nums text-foreground">
                      {formatCurrency(row.price)}
                    </p>
                    <p
                      className={cn(
                        "text-xs font-medium",
                        changePct === null && "text-muted-foreground",
                        changePct !== null &&
                          changePct >= 0 &&
                          "text-emerald-600 dark:text-emerald-400",
                        changePct !== null &&
                          changePct < 0 &&
                          "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {changePct === null
                        ? "Change unavailable"
                        : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`}
                    </p>
                  </div>
                  <MaterialRipple
                    variant="none"
                    effect="fade"
                    disableHover
                    className="z-10"
                  />
                </button>
              );
            })}
          </div>
        )}

        {hasMoreRows ? (
          <div ref={endOfList} className="border-t border-border px-4 py-1 text-center">
            {canObserve ? null : (
              <button
                type="button"
                className="ui-text-row-description min-h-11 px-4 text-muted-foreground"
                onClick={() => setVisibleCount((count) => count + PICKS_BATCH_SIZE)}
              >
                Show more
              </button>
            )}
          </div>
        ) : null}
      </SettingsGroup>

      <KaiControlSurface
        open={Boolean(selectedRow)}
        onOpenChange={(open) => {
          if (!open) setSelectedRow(null);
        }}
        leading={
          selectedRow ? (
            <SymbolAvatar
              symbol={String(
                selectedRow.quote_symbol || selectedRow.symbol || "—",
              )}
              name={selectedRow.company_name}
              size="lg"
            />
          ) : null
        }
        title={
          selectedRow?.company_name || selectedRow?.symbol || "Stock detail"
        }
        description={
          selectedRow
            ? [
                selectedRow.symbol,
                selectedRow.sector,
                activeSource?.label || "Advisor list",
              ]
                .filter(Boolean)
                .join(" • ")
            : undefined
        }
        surfaceClassName={styles.detail}
        headerTextOverflow="wrap"
        footer={selectedRow && onAnalyze ? <div className="flex w-full justify-center"><Button size="standard" data-voice-control-id="analysis_stock_details_preview" onClick={() => {
          const symbol = selectedRow.symbol;
          setSelectedRow(null);
          onAnalyze(symbol);
        }}>Analyze {selectedRow.symbol}</Button></div> : undefined}
      >
        {selectedRow ? <StockDetailContent key={selectedRow.symbol} row={selectedRow} facts={selectedFacts} loadHistory={loadHistory} loadQuote={loadQuote} news={news} /> : null}
      </KaiControlSurface>
    </div>
  );
}

export const RenaissanceMarketList = RiaPicksList;
