"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, TrendingDown, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SurfaceInset } from "@/components/app-ui/surfaces";
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
  SettingsSegmentedTabs,
} from "@/components/profile/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import type {
  KaiHomePickSource,
  KaiHomeRenaissanceItem,
} from "@/lib/services/api-service";
import { cn } from "@/lib/utils";

const ALL_FILTER = "all";
const DEFAULT_PICKS_PAGE_SIZE = 10;
const PICKS_PAGE_SIZE_OPTIONS = [10, 25, 50] as const;

function parsePageSize(value: string): number {
  const parsed = Number(value);
  return PICKS_PAGE_SIZE_OPTIONS.includes(parsed as (typeof PICKS_PAGE_SIZE_OPTIONS)[number])
    ? parsed
    : DEFAULT_PICKS_PAGE_SIZE;
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

function renderSymbolMonogram(symbol: string) {
  return (
    <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-emerald-500/18 bg-emerald-500/10 text-[12px] font-black tracking-wide text-emerald-700 shadow-sm dark:text-emerald-300">
      {symbol.slice(0, 4)}
    </span>
  );
}

function rowSearchText(row: KaiHomeRenaissanceItem): string {
  return [
    row.symbol,
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
  const [selectedRow, setSelectedRow] = useState<KaiHomeRenaissanceItem | null>(null);
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<string>(ALL_FILTER);
  const [sectorFilter, setSectorFilter] = useState<string>(ALL_FILTER);
  const [pageSize, setPageSize] = useState(DEFAULT_PICKS_PAGE_SIZE);
  const [page, setPage] = useState(1);

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
    if (totalPages <= 5) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }
    const start = Math.max(1, Math.min(page - 2, totalPages - 4));
    return Array.from({ length: 5 }, (_, index) => start + index);
  }, [page, totalPages]);

  const visibleStart = filteredRows.length === 0 ? 0 : (page - 1) * pageSize + 1;
  const visibleEnd = Math.min(page * pageSize, filteredRows.length);

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
        <div className="space-y-3 px-3 py-3 sm:px-4">
          {availableSources.length > 1 ? (
            <SettingsSegmentedTabs
              value={activeSource?.id || "default"}
              onValueChange={(nextValue) => {
                if (!onSourceChange || nextValue === activeSource?.id) return;
                onSourceChange(nextValue);
              }}
              options={availableSources.map((source) => ({
                value: source.id,
                label: source.label,
              }))}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  "border font-medium",
                  displaySource ? sourceStateTone(displaySource) : undefined
                )}
              >
                {displaySource?.label || "Default list"}
              </Badge>
              <p className="text-xs leading-5 text-muted-foreground">
                {pickSourceSummary(displaySource)}
              </p>
            </div>
          )}

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
                  setPageSize(parsePageSize(value));
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-8 min-w-[112px] rounded-full border-border/70 bg-background/78 text-xs">
                  <SelectValue placeholder="10 per page" />
                </SelectTrigger>
                <SelectContent>
                  {PICKS_PAGE_SIZE_OPTIONS.map((option) => (
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
          currentPageRows.map((row) => {
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
              <SettingsRow
                key={`${row.symbol}-${row.tier || "tierless"}`}
                leading={renderSymbolMonogram(String(row.symbol || "—"))}
                title={
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold tracking-tight text-foreground sm:text-[15px]">
                      {row.company_name || row.symbol}
                    </span>
                    <Badge
                      variant="secondary"
                      className={cn("border-0 text-[10px] font-semibold", tierTone(row.tier))}
                    >
                      {row.tier || "CORE"}
                    </Badge>
                    {row.degraded ? (
                      <Badge
                        variant="outline"
                        className="border-amber-500/16 bg-amber-500/8 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                      >
                        Delayed
                      </Badge>
                    ) : null}
                  </div>
                }
                description={
                  <>
                    <p>{metadataLine || "Metadata is still syncing for this name."}</p>
                    <p className="mt-1 line-clamp-1">
                      {row.investment_thesis ||
                        "Renaissance thesis is unavailable for this name right now."}
                    </p>
                  </>
                }
                trailing={
                  <div className="text-right">
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
                }
                chevron
                onClick={() => setSelectedRow(row)}
              />
            );
          })
        )}

        {filteredRows.length > pageSize ? (
          <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
            <p className="text-xs leading-5 text-muted-foreground">
              Page {page} of {totalPages}
            </p>
            <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
              <Button
                variant="none"
                effect="fade"
                size="sm"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page === 1}
              >
                Previous
              </Button>
              {pageNumbers.map((pageNumber) => (
                <Button
                  key={pageNumber}
                  variant="none"
                  effect="fade"
                  size="sm"
                  className={
                    pageNumber === page
                      ? "bg-foreground text-background hover:bg-foreground/92 dark:bg-foreground dark:text-background"
                      : undefined
                  }
                  onClick={() => setPage(pageNumber)}
                >
                  {pageNumber}
                </Button>
              ))}
              <Button
                variant="none"
                effect="fade"
                size="sm"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={page === totalPages}
              >
                Next
              </Button>
            </div>
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
              {renderSymbolMonogram(String(selectedRow.symbol || "—"))}
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
                trailing={formatAsOf(selectedRow.as_of)}
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
