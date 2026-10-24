"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";


import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { StockDetailContent, type StockHistoryLoader } from "@/components/kai/cards/stock-detail-content";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import { StockListToolbar, StockRowsPerPage } from "@/components/kai/cards/stock-list-toolbar";
import { useIsMobile } from "@/hooks/use-mobile";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Button } from "@/lib/morphy-ux/button";
import { SettingsGroup } from "@/components/profile/settings-ui";
import { marketSettingsGroupClassName } from "@/components/kai/shared/market-surface-theme";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import type {
  KaiHomeNewsItem,
  KaiHomePickSource,
  KaiHomeRenaissanceItem,
  KaiMarketCompanyFacts,
} from "@/lib/services/api-service";
import { cn } from "@/lib/utils";
import { formatCurrency, formatCompactNumber } from "@/lib/kai/market-value-format";



const ALL_FILTER = "all";
const MOBILE_PICKS_PAGE_SIZE_OPTIONS = [8, 12, 16] as const;
const DESKTOP_PICKS_PAGE_SIZE_OPTIONS = [8, 16, 24] as const;



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
  toolbarActions?: ReactNode;
  news?: KaiHomeNewsItem[];
}) {
  const isMobile = useIsMobile();
  void controlMode;
  const pageSizeOptions: readonly number[] = isMobile
    ? MOBILE_PICKS_PAGE_SIZE_OPTIONS
    : DESKTOP_PICKS_PAGE_SIZE_OPTIONS;
  const defaultPageSize = pageSizeOptions[0] ?? 6;
  const [selectedRow, setSelectedRow] = useState<KaiHomeRenaissanceItem | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<string>(ALL_FILTER);
  const [sectorFilter, setSectorFilter] = useState<string>(ALL_FILTER);
  const [pageSize, setPageSize] = useState<number>(defaultPageSize);
  const [page, setPage] = useState(1);
  const [factsBySymbol, setFactsBySymbol] = useState<Record<string, KaiMarketCompanyFacts>>({});

  useEffect(() => {
    onSelectedSymbolChange?.(selectedRow?.symbol ?? null);
    return () => onSelectedSymbolChange?.(null);
  }, [onSelectedSymbolChange, selectedRow?.symbol]);


  useEffect(() => {
    setPageSize((current) => {
      if (pageSizeOptions.includes(current)) {
        return current;
      }
      return defaultPageSize;
    });
  }, [defaultPageSize, pageSizeOptions]);

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
    setPage(1);
  }, [activeSourceId, pageSize, query, sectorFilter, tierFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, totalPages));
  }, [totalPages]);

  const currentPageRows = useMemo(() => {
    const startIndex = (page - 1) * pageSize;
    return filteredRows.slice(startIndex, startIndex + pageSize);
  }, [filteredRows, page, pageSize]);
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

  const pageNumbers = useMemo(() => {
    if (isMobile) {
      if (totalPages <= 3) {
        return Array.from({ length: totalPages }, (_, index) => index + 1);
      }

      if (page <= 2) {
        return [1, 2, "ellipsis-end", totalPages] as const;
      }

      if (page >= totalPages - 1) {
        return [1, "ellipsis-start", totalPages - 1, totalPages] as const;
      }

      return [1, "ellipsis-start", page, "ellipsis-end", totalPages] as const;
    }

    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    if (page <= 4) {
      return [1, 2, 3, 4, 5, "ellipsis-end", totalPages] as const;
    }

    if (page >= totalPages - 3) {
      return [
        1,
        "ellipsis-start",
        totalPages - 4,
        totalPages - 3,
        totalPages - 2,
        totalPages - 1,
        totalPages,
      ] as const;
    }

    return [
      1,
      "ellipsis-start",
      page - 1,
      page,
      page + 1,
      "ellipsis-end",
      totalPages,
    ] as const;
  }, [isMobile, page, totalPages]);

  const visibleStart =
    filteredRows.length === 0 ? 0 : (page - 1) * pageSize + 1;
  const visibleEnd = Math.min(page * pageSize, filteredRows.length);


  const goToPage = (nextPage: number) => {
    setPage(Math.max(1, Math.min(totalPages, nextPage)));
  };

  return (
    <div className={cn(styles.detail, "space-y-4")}>
      <StockListToolbar query={query} setQuery={setQuery} tier={tierFilter} setTier={setTierFilter}
        sector={sectorFilter} setSector={setSectorFilter} sectors={sectors}
        pageSize={pageSize} setPageSize={setPageSize} pageSizes={pageSizeOptions}
        sources={availableSources} activeSource={activeSource?.id || "default"} onSourceChange={onSourceChange} actions={toolbarActions} />
      <div className="flex items-baseline justify-between gap-3"><h2 className="text-sm font-semibold">Companies</h2><p className="text-xs text-muted-foreground">{filteredRows.length} results</p></div>
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

              return (
                <button
                  key={`${row.symbol}-${row.tier || "tierless"}`}
                  type="button"
                  data-testid="market-pick-row"
                  data-no-route-swipe
                  onClick={() => setSelectedRow(row)}
                  className={cn(
                    "group relative isolate flex w-full gap-3 text-left transition-colors",
                    "items-center border-t border-border/60 px-4 py-4 hover:bg-muted/40 active:bg-muted/60 first:border-t-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
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
                    className="z-10"
                  />
                </button>
              );
            })}
          </div>
        )}

        {filteredRows.length > pageSize ? (
          <div
            className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4"
            data-no-route-swipe
          >
            <div className="space-y-1">
              <p className="text-xs leading-5 text-muted-foreground">
                Page {page} of {totalPages}
              </p>
            </div>
            <Pagination className="mx-0 w-full sm:w-auto sm:justify-end">
              <PaginationContent className="flex-nowrap justify-start sm:justify-end">
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    className={cn(
                      page === 1 && "pointer-events-none opacity-50",
                    )}
                    onClick={(event) => {
                      event.preventDefault();
                      goToPage(page - 1);
                    }}
                  />
                </PaginationItem>
                {pageNumbers.map((pageNumber) => {
                  if (typeof pageNumber !== "number") {
                    return (
                      <PaginationItem key={pageNumber}>
                        <PaginationEllipsis />
                      </PaginationItem>
                    );
                  }

                  return (
                    <PaginationItem key={pageNumber}>
                      <PaginationLink
                        href="#"
                        isActive={pageNumber === page}
                        size="icon"
                        onClick={(event) => {
                          event.preventDefault();
                          goToPage(pageNumber);
                        }}
                      >
                        {pageNumber}
                      </PaginationLink>
                    </PaginationItem>
                  );
                })}
                <PaginationItem>
                  <PaginationNext
                    href="#"
                    className={cn(
                      page === totalPages && "pointer-events-none opacity-50",
                    )}
                    onClick={(event) => {
                      event.preventDefault();
                      goToPage(page + 1);
                    }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        ) : null}
      </SettingsGroup>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs leading-[18px] text-muted-foreground">{visibleStart}–{visibleEnd} of {filteredRows.length} companies</p><StockRowsPerPage value={pageSize} onChange={setPageSize} options={pageSizeOptions} /></div>

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
        footer={selectedRow && onAnalyze ? <Button variant="none" effect="fade" data-voice-control-id="analysis_stock_details_preview" onClick={() => {
          const symbol = selectedRow.symbol;
          setSelectedRow(null);
          onAnalyze(symbol);
        }}>Analyze {selectedRow.symbol}</Button> : undefined}
      >
        {selectedRow ? <StockDetailContent key={selectedRow.symbol} row={selectedRow} facts={selectedFacts} loadHistory={loadHistory} news={news} /> : null}
      </KaiControlSurface>
    </div>
  );
}

export const RenaissanceMarketList = RiaPicksList;
