"use client";

import { useMemo, useState } from "react";
import {
  Search,
  FileQuestion,
} from "lucide-react";

import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

import {
  DecisionCard,
  type PortfolioContext,
} from "@/components/kai/decision-card";
import type {
  AnalysisHistoryEntry,
  AnalysisHistoryMap,
} from "@/lib/services/kai-history-service";
import type { Holding } from "@/components/kai/types/portfolio";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SortField = "date" | "confidence" | "ticker";
export type SortDirection = "asc" | "desc";

export interface DecisionCardsGridProps {
  /** All analysis history entries keyed by ticker */
  historyMap: AnalysisHistoryMap;
  /** Optional portfolio holdings for personalization (decrypted client-side) */
  holdings?: Holding[];
  /** Total portfolio value for allocation % */
  totalPortfolioValue?: number;
  /** Card action callbacks (passed through to each DecisionCard) */
  onSave?: (ticker: string) => void;
  onShare?: (ticker: string) => void;
  onCompare?: (ticker: string) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenHistory(historyMap: AnalysisHistoryMap): AnalysisHistoryEntry[] {
  return Object.values(historyMap)
    .flatMap((entries) => entries)
    .filter(Boolean);
}

function extractSectors(entries: AnalysisHistoryEntry[], holdings?: Holding[]): string[] {
  const sectors = new Set<string>();
  for (const h of holdings ?? []) {
    if (h.sector) sectors.add(h.sector);
  }
  // Also pull from raw_card if present
  for (const e of entries) {
    const sector = (e.raw_card as Record<string, unknown>)?.sector;
    if (typeof sector === "string" && sector.trim()) {
      sectors.add(sector.trim());
    }
  }
  return Array.from(sectors).sort();
}

function matchesSearch(entry: AnalysisHistoryEntry, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (entry.ticker.toLowerCase().includes(q)) return true;
  if (entry.final_statement?.toLowerCase().includes(q)) return true;
  if (String(entry.decision).toLowerCase().includes(q)) return true;
  return false;
}

function holdingForTicker(
  holdings: Holding[] | undefined,
  ticker: string
): Holding | null {
  if (!holdings) return null;
  const upper = ticker.toUpperCase();
  return holdings.find((h) => h.symbol.toUpperCase() === upper) ?? null;
}

function sortEntries(
  entries: AnalysisHistoryEntry[],
  field: SortField,
  direction: SortDirection
): AnalysisHistoryEntry[] {
  const sorted = [...entries].sort((a, b) => {
    if (field === "date") {
      return Date.parse(b.timestamp) - Date.parse(a.timestamp);
    }
    if (field === "confidence") {
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    }
    // ticker
    return a.ticker.localeCompare(b.ticker);
  });
  return direction === "desc" ? sorted : sorted.reverse();
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  searchQuery,
  onSearchChange,
  sortField,
  onSortFieldChange,
  sectors,
  activeSector,
  onSectorChange,
}: {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  sortField: SortField;
  onSortFieldChange: (f: SortField) => void;
  sectors: string[];
  activeSector: string | null;
  onSectorChange: (s: string | null) => void;
}) {
  return (
    <div className="space-y-3">
      {/* Search + sort row */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Icon
            icon={Search}
            size="sm"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
          />
          <input
            type="text"
            placeholder="Search decisions..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-9 w-full rounded-xl border border-border/60 bg-muted/30 pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-primary/40 transition-colors"
          />
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-border/60 bg-muted/30 p-0.5">
          {(["date", "confidence", "ticker"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onSortFieldChange(f)}
              className={cn(
                "rounded-lg px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors",
                f === sortField
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f === "date" ? "Date" : f === "confidence" ? "Conf" : "A-Z"}
            </button>
          ))}
        </div>
      </div>

      {/* Sector chips */}
      {sectors.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onSectorChange(null)}
            className={cn(
              "rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide transition-colors",
              activeSector === null
                ? "bg-primary/10 text-primary"
                : "bg-muted/40 text-muted-foreground hover:bg-muted/60"
            )}
          >
            All
          </button>
          {sectors.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSectorChange(s === activeSector ? null : s)}
              className={cn(
                "rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide transition-colors",
                s === activeSector
                  ? "bg-primary/10 text-primary"
                  : "bg-muted/40 text-muted-foreground hover:bg-muted/60"
              )}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-muted/50">
        <Icon icon={FileQuestion} size="lg" className="text-muted-foreground/60" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold">No Decision Cards Yet</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Analyze a stock with Kai to see personalized decision cards here.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DecisionCardsGrid({
  historyMap,
  holdings,
  totalPortfolioValue,
  onSave,
  onShare,
  onCompare,
  className,
}: DecisionCardsGridProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>("date");
  const [activeSector, setActiveSector] = useState<string | null>(null);

  const allEntries = useMemo(() => flattenHistory(historyMap), [historyMap]);
  const sectors = useMemo(
    () => extractSectors(allEntries, holdings),
    [allEntries, holdings]
  );

  const filtered = useMemo(() => {
    let result = allEntries;

    // Text search
    if (searchQuery.trim()) {
      result = result.filter((e) => matchesSearch(e, searchQuery.trim()));
    }

    // Sector filter
    if (activeSector) {
      result = result.filter((e) => {
        const holding = holdingForTicker(holdings, e.ticker);
        if (holding?.sector === activeSector) return true;
        const cardSector = (e.raw_card as Record<string, unknown>)?.sector;
        return typeof cardSector === "string" && cardSector.trim() === activeSector;
      });
    }

    // Sort
    return sortEntries(result, sortField, "desc");
  }, [allEntries, searchQuery, activeSector, sortField, holdings]);

  if (allEntries.length === 0) {
    return (
      <div className={className}>
        <EmptyState />
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      <FilterBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        sortField={sortField}
        onSortFieldChange={setSortField}
        sectors={sectors}
        activeSector={activeSector}
        onSectorChange={setActiveSector}
      />

      {filtered.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          No decisions match your filters.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((entry) => {
            const holding = holdingForTicker(holdings, entry.ticker);
            const portfolioContext: PortfolioContext | null = holding
              ? { holding, totalPortfolioValue }
              : null;

            return (
              <DecisionCard
                key={`${entry.ticker}-${entry.timestamp}`}
                entry={entry}
                portfolioContext={portfolioContext}
                onSave={onSave}
                onShare={onShare}
                onCompare={onCompare}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export default DecisionCardsGrid;
