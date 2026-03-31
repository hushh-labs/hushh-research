"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, TrendingDown, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/hooks/use-mobile";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
} from "@/components/profile/settings-ui";
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
  KaiHomePickSource,
  KaiHomeRenaissanceItem,
} from "@/lib/services/api-service";
import { cn } from "@/lib/utils";

const ALL_FILTER = "all";
const MOBILE_PICKS_PAGE_SIZE_OPTIONS = [8, 12, 16] as const;
const DESKTOP_PICKS_PAGE_SIZE_OPTIONS = [8, 16, 24] as const;
const PICKS_SWIPE_THRESHOLD_PX = 44;

function parsePageSize(value: string, options: readonly number[], fallback: number): number {
  const parsed = Number(value);
  return options.includes(parsed) ? parsed : fallback;
}

function formatCurrency(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Price unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCompactNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatFcf(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "FCF N/A";
  return `$${value.toFixed(value >= 10 ? 0 : 1)}B FCF`;
}

function formatBias(value: string | null | undefined): string | null {
  const text = String(value || "").trim();
  return text ? text.replaceAll("_", " ") : null;
}

function formatAsOf(value: string | null | undefined): string {
  const text = String(value || "").trim();
  if (!text) return "Snapshot time unavailable";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "Snapshot time unavailable";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function tierTone(tier: string | null | undefined): string {
  const normalized = String(tier || "").trim().toUpperCase();
  if (normalized === "ACE") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (normalized === "KING") return "bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (normalized === "QUEEN") return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (normalized === "JACK") return "bg-violet-500/10 text-violet-700 dark:text-violet-300";
  return "bg-muted text-muted-foreground";
}

function sourceStateTone(source: KaiHomePickSource): string {
  if (source.state === "pending") {
    return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (source.state === "unavailable") {
    return "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  }
  return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

function pickSourceSummary(source: KaiHomePickSource | null): string {
  if (!source) {
    return "Using the app-wide default list until advisor picks are linked.";
  }
  if (source.kind === "ria" && source.share_origin === "relationship_implicit") {
    if (source.state === "ready") {
      return "This advisor feed is included through your approved advisor relationship.";
    }
    if (source.state === "pending") {
      return "Your advisor relationship includes this feed, but the advisor has not uploaded an active list yet.";
    }
  }
  if (source.kind === "ria" && source.state !== "ready") {
    return "Advisor-specific picks are not available yet, so Kai is still using the default list.";
  }
  if (source.kind === "ria") {
    return "This list reflects the currently selected advisor source.";
  }
  return "Using the app-wide default list until advisor picks are linked.";
}

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

export function RiaPicksList({
  rows = [],
  sources = [],
  activeSourceId = "default",
  onSourceChange,
}: {
  rows?: KaiHomeRenaissanceItem[];
  sources?: KaiHomePickSource[];
  activeSourceId?: string;
  onSourceChange?: (sourceId: string) => void;
}) {
  const isMobile = useIsMobile();
  const pageSizeOptions: readonly number[] = isMobile
    ? MOBILE_PICKS_PAGE_SIZE_OPTIONS
    : DESKTOP_PICKS_PAGE_SIZE_OPTIONS;
  const defaultPageSize = pageSizeOptions[0] ?? 6;
  const [selectedRow, setSelectedRow] = useState<KaiHomeRenaissanceItem | null>(null);
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<string>(ALL_FILTER);
  const [sectorFilter, setSectorFilter] = useState<string>(ALL_FILTER);
  const [pageSize, setPageSize] = useState<number>(defaultPageSize);
  const [page, setPage] = useState(1);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

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
    [sources]
  );

  const activeSource = useMemo(
    () =>
      availableSources.find((source) => source.id === activeSourceId) ??
      availableSources[0] ??
      null,
    [activeSourceId, availableSources]
  );
  const displaySource = activeSource ?? availableSources[0] ?? null;

  const sectors = useMemo(
    () =>
      [...new Set(rows.map((row) => String(row.sector || "").trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [rows]
  );

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesTier =
        tierFilter === ALL_FILTER || String(row.tier || "").trim().toUpperCase() === tierFilter;
      const matchesSector =
        sectorFilter === ALL_FILTER || String(row.sector || "").trim() === sectorFilter;
      const matchesQuery = !normalizedQuery || rowSearchText(row).includes(normalizedQuery);
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

  const pageNumbers = useMemo(() => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    if (page <= 4) {
      return [1, 2, 3, 4, 5, "ellipsis-end", totalPages] as const;
    }

    if (page >= totalPages - 3) {
      return [1, "ellipsis-start", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages] as const;
    }

    return [1, "ellipsis-start", page - 1, page, page + 1, "ellipsis-end", totalPages] as const;
  }, [page, totalPages]);

  const visibleStart = filteredRows.length === 0 ? 0 : (page - 1) * pageSize + 1;
  const visibleEnd = Math.min(page * pageSize, filteredRows.length);

  const goToPage = (nextPage: number) => {
    setPage(Math.max(1, Math.min(totalPages, nextPage)));
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.changedTouches[0];
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!touch || !start || totalPages <= 1) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) < PICKS_SWIPE_THRESHOLD_PX) return;
    if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return;

    if (deltaX < 0) {
      goToPage(page + 1);
      return;
    }

    goToPage(page - 1);
  };

  if (!rows.length) {
    return (
      <SettingsGroup>
        <div className="px-4 py-4 text-sm text-muted-foreground">
          The default list is unavailable at the moment.
        </div>
      </SettingsGroup>
    );
  }

  return (
    <div className="space-y-4">
      <SettingsGroup>
        <div className="space-y-3 px-4 py-3 sm:px-4">
          <SettingsRow
            title="List source"
            description={pickSourceSummary(displaySource)}
            stackTrailingOnMobile
            trailing={
              <Select
                value={activeSource?.id || "default"}
                onValueChange={(nextValue) => {
                  if (!onSourceChange || nextValue === activeSource?.id) return;
                  onSourceChange(nextValue);
                }}
              >
                <SelectTrigger
                  className={cn(
                    "h-10 min-w-[176px] max-w-[240px] rounded-full border-border/80 bg-background/80 text-left",
                    displaySource ? sourceStateTone(displaySource) : undefined
                  )}
                >
                  <SelectValue placeholder="Default list" />
                </SelectTrigger>
                <SelectContent align="end">
                  {availableSources.map((source) => (
                    <SelectItem key={source.id} value={source.id}>
                      {source.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1.35fr)_180px_180px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search symbol, company, sector, or thesis"
                className="h-10 rounded-2xl border-border/80 bg-background/80 pl-9"
              />
            </div>
            <Select value={tierFilter} onValueChange={setTierFilter}>
              <SelectTrigger className="h-10 w-full rounded-2xl border-border/80 bg-background/80">
                <SelectValue placeholder="All tiers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER}>All tiers</SelectItem>
                <SelectItem value="ACE">ACE</SelectItem>
                <SelectItem value="KING">KING</SelectItem>
                <SelectItem value="QUEEN">QUEEN</SelectItem>
                <SelectItem value="JACK">JACK</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sectorFilter} onValueChange={setSectorFilter}>
              <SelectTrigger className="h-10 w-full rounded-2xl border-border/80 bg-background/80">
                <SelectValue placeholder="All sectors" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER}>All sectors</SelectItem>
                {sectors.map((sector) => (
                  <SelectItem key={sector} value={sector}>
                    {sector}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs leading-5 text-muted-foreground">
              {filteredRows.length > 0
                ? `Showing ${visibleStart}-${visibleEnd} of ${filteredRows.length} matching names.`
                : `Showing 0 matching names · ${rows.length} total investable names.`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(parsePageSize(value, pageSizeOptions, defaultPageSize));
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-8 min-w-[112px] rounded-full border-border/70 bg-background/78 text-xs">
                  <SelectValue placeholder={`${defaultPageSize} per page`} />
                </SelectTrigger>
                <SelectContent>
                  {pageSizeOptions.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {option} per page
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {tierFilter !== ALL_FILTER ? (
                <Badge
                  variant="outline"
                  className="border-border/70 bg-background/80 text-muted-foreground"
                >
                  Tier {tierFilter}
                </Badge>
              ) : null}
              {sectorFilter !== ALL_FILTER ? (
                <Badge
                  variant="outline"
                  className="border-border/70 bg-background/80 text-muted-foreground"
                >
                  {sectorFilter}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>

        {filteredRows.length === 0 ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">
            No picks match the current filters.
          </div>
        ) : (
          <div
            className="touch-pan-y"
            data-no-route-swipe
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            {currentPageRows.map((row) => {
              const changePct =
                typeof row.change_pct === "number" && Number.isFinite(row.change_pct)
                  ? row.change_pct
                  : null;
              const metadataLine = [
                row.symbol,
                row.sector,
                formatBias(row.recommendation_bias),
                typeof row.fcf_billions === "number" && Number.isFinite(row.fcf_billions)
                  ? formatFcf(row.fcf_billions)
                  : null,
              ]
                .filter(Boolean)
                .join(" • ");

              return (
                <button
                  key={`${row.symbol}-${row.tier || "tierless"}`}
                  type="button"
                  data-no-route-swipe
                  onClick={() => setSelectedRow(row)}
                  className="group relative isolate flex w-full items-center gap-3 overflow-hidden border-t border-border/55 px-4 py-2.5 text-left transition-colors hover:bg-foreground/[0.04] active:bg-foreground/[0.06] first:border-t-0"
                >
                  <div className="shrink-0">
                    <SymbolAvatar
                      symbol={String(row.quote_symbol || row.symbol || "—")}
                      name={row.company_name}
                      size="md"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-semibold tracking-tight text-foreground">
                        {row.symbol || "—"}
                      </span>
                      <Badge
                        variant="secondary"
                        className={cn("border-0 px-2 py-0.5 text-[10px] font-semibold", tierTone(row.tier))}
                      >
                        {row.tier || "CORE"}
                      </Badge>
                      {row.alias_repaired ? (
                        <Badge
                          variant="outline"
                          className="border-sky-500/16 bg-sky-500/8 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300"
                        >
                          Repaired
                        </Badge>
                      ) : null}
                      {row.degraded ? (
                        <Badge
                          variant="outline"
                          className="border-amber-500/16 bg-amber-500/8 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                        >
                          Delayed
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-2">
                      <p className="truncate text-xs font-medium text-foreground/85">
                        {row.company_name || row.symbol}
                      </p>
                    </div>
                    <p className="mt-0.5 truncate text-[11px] leading-5 text-muted-foreground">
                      {metadataLine || "Metadata is still syncing for this name."}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold tracking-tight text-foreground">
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
                          "text-rose-600 dark:text-rose-400"
                      )}
                    >
                      {changePct === null
                        ? "Change unavailable"
                        : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`}
                    </p>
                  </div>
                  <MaterialRipple variant="none" effect="fade" className="z-10" />
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
              {totalPages > 1 ? (
                <p className="text-[11px] leading-5 text-muted-foreground">
                  Swipe left or right anywhere in this list to move between pages.
                </p>
              ) : null}
            </div>
            <Pagination className="mx-0 w-full sm:w-auto sm:justify-end">
              <PaginationContent className="flex-wrap justify-start sm:justify-end">
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    className={cn(page === 1 && "pointer-events-none opacity-50")}
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
                    className={cn(page === totalPages && "pointer-events-none opacity-50")}
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

      <SettingsDetailPanel
        open={Boolean(selectedRow)}
        onOpenChange={(open) => {
          if (!open) setSelectedRow(null);
        }}
        title={selectedRow ? `${selectedRow.symbol} · ${selectedRow.company_name}` : "Pick detail"}
        description={
          selectedRow
            ? "Advisor list detail with the current market snapshot and thesis."
            : undefined
        }
      >
        {selectedRow ? (
          <div className="space-y-4">
            <SurfaceInset className="flex items-start gap-3 p-4">
              <SymbolAvatar
                symbol={String(selectedRow.quote_symbol || selectedRow.symbol || "—")}
                name={selectedRow.company_name}
                size="lg"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-lg font-semibold tracking-tight text-foreground">
                    {selectedRow.company_name || selectedRow.symbol}
                  </p>
                  <Badge
                    variant="secondary"
                    className={cn("border-0 text-[10px] font-semibold", tierTone(selectedRow.tier))}
                  >
                    {selectedRow.tier || "CORE"}
                  </Badge>
                  {selectedRow.degraded ? (
                    <Badge
                      variant="outline"
                      className="border-amber-500/16 bg-amber-500/8 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                    >
                      Delayed
                    </Badge>
                  ) : null}
                  {selectedRow.alias_repaired ? (
                    <Badge
                      variant="outline"
                      className="border-sky-500/16 bg-sky-500/8 text-[10px] font-semibold text-sky-700 dark:text-sky-300"
                    >
                      Symbol repaired
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {[
                    selectedRow.symbol,
                    selectedRow.sector,
                    formatBias(selectedRow.recommendation_bias),
                  ]
                    .filter(Boolean)
                    .join(" • ")}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-2xl font-semibold tracking-tight text-foreground">
                    {formatCurrency(selectedRow.price)}
                  </span>
                  {typeof selectedRow.change_pct === "number" &&
                  Number.isFinite(selectedRow.change_pct) ? (
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold",
                        selectedRow.change_pct >= 0
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "bg-rose-500/10 text-rose-700 dark:text-rose-300"
                      )}
                    >
                      {selectedRow.change_pct >= 0 ? (
                        <TrendingUp className="mr-1 h-3.5 w-3.5" />
                      ) : (
                        <TrendingDown className="mr-1 h-3.5 w-3.5" />
                      )}
                      {selectedRow.change_pct >= 0 ? "+" : ""}
                      {selectedRow.change_pct.toFixed(2)}%
                    </span>
                  ) : null}
                </div>
              </div>
            </SurfaceInset>

            <SettingsGroup eyebrow="Context" title="Market snapshot and conviction">
              <SettingsRow
                title="Market cap"
                description="Current capitalization snapshot from the latest available quote."
                trailing={formatCompactNumber(selectedRow.market_cap)}
              />
              <SettingsRow
                title="Free cash flow"
                description="Renaissance free-cash-flow cue from the default list."
                trailing={formatFcf(selectedRow.fcf_billions)}
              />
              <SettingsRow
                title="Quote freshness"
                description={
                  selectedRow.degraded
                    ? "This row is using delayed or incomplete quote context."
                    : "Quote context is current for the latest market snapshot."
                }
                trailing={
                  selectedRow.quote_status === "unsupported"
                    ? "Unsupported"
                    : formatAsOf(selectedRow.as_of)
                }
              />
            </SettingsGroup>

            <SettingsGroup eyebrow="Thesis" title="Why this name is in the list">
              <div className="px-4 py-4 text-sm leading-7 text-foreground/90">
                {selectedRow.investment_thesis ||
                  "Renaissance thesis is unavailable for this name right now."}
              </div>
            </SettingsGroup>

            <div className="flex flex-wrap gap-2">
              {selectedRow.sector ? (
                <Badge
                  variant="outline"
                  className="border-emerald-500/16 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300"
                >
                  {selectedRow.sector}
                </Badge>
              ) : null}
              {selectedRow.recommendation_bias ? (
                <Badge
                  variant="outline"
                  className="border-sky-500/16 bg-sky-500/8 text-sky-700 dark:text-sky-300"
                >
                  {formatBias(selectedRow.recommendation_bias)}
                </Badge>
              ) : null}
              <Badge
                variant="outline"
                className="border-border bg-background text-muted-foreground"
              >
                {activeSource?.label || "Default list"}
              </Badge>
            </div>
          </div>
        ) : null}
      </SettingsDetailPanel>
    </div>
  );
}

export const RenaissanceMarketList = RiaPicksList;
