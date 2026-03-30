"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Compass,
  History,
  Search,
  ShieldCheck,
  UserRound,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  getTickerUniverseSnapshot,
  preloadTickerUniverse,
  searchTickerUniverseRemote,
  searchTickerUniverse,
  type TickerUniverseRow,
} from "@/lib/kai/ticker-universe-cache";
import { Icon } from "@/lib/morphy-ux/ui";

export type KaiCommandAction =
  | "analyze"
  | "optimize"
  | "consent"
  | "profile"
  | "history"
  | "dashboard"
  | "home";

interface KaiCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommand: (command: KaiCommandAction, params?: Record<string, unknown>) => void;
  hasPortfolioData?: boolean;
  portfolioTickers?: Array<{
    symbol: string;
    name?: string;
    sector?: string;
    asset_type?: string;
    is_investable?: boolean;
    analyze_eligible?: boolean;
  }>;
}

function isPortfolioAnalyzeEligible(row: {
  is_investable?: boolean;
  analyze_eligible?: boolean;
  asset_type?: string;
}): boolean {
  if (typeof row.analyze_eligible === "boolean") return row.analyze_eligible;
  if (row.is_investable !== true) return false;
  const assetType = String(row.asset_type || "").toLowerCase();
  if (
    assetType.includes("cash") ||
    assetType.includes("sweep") ||
    assetType.includes("bond") ||
    assetType.includes("fixed income")
  ) {
    return false;
  }
  return true;
}

function isLikelySecCommonEquityRow(row: TickerUniverseRow): boolean {
  if (row.tradable === false) return false;
  const ticker = String(row.ticker || "").trim().toUpperCase();
  if (!ticker) return false;

  const combined = [
    String(row.title || ""),
    String(row.sector || row.sector_primary || ""),
    String(row.industry || row.industry_primary || ""),
    String(row.sic_description || ""),
  ]
    .join(" ")
    .toLowerCase();

  if (ticker.endsWith("X")) return false;
  if (
    /(?:\betf\b|\bfund\b|\bmutual\b|\btrust\b|\bmoney market\b|\bcash\b|\bsweep\b|\bbond\b|\bfixed income\b|\btreasury\b|\bmunicipal\b|\breit\b|\bcommodity\b|\bgold\b)/i.test(
      combined
    )
  ) {
    return false;
  }
  return true;
}

const GENERIC_SECTOR_LABELS = new Set([
  "equity",
  "equities",
  "stock",
  "stocks",
  "other",
  "unknown",
  "unclassified",
  "n/a",
]);

function toNonEmpty(value: unknown): string | undefined {
  const text = String(value || "").trim();
  return text ? text : undefined;
}

function isSpecificSectorLabel(value: unknown): boolean {
  const text = toNonEmpty(value);
  if (!text) return false;
  return !GENERIC_SECTOR_LABELS.has(text.toLowerCase());
}

function pickPreferredLabel(values: Array<unknown>): string | undefined {
  let fallback: string | undefined;
  for (const value of values) {
    const text = toNonEmpty(value);
    if (!text) continue;
    if (!fallback) fallback = text;
    if (isSpecificSectorLabel(text)) {
      return text;
    }
  }
  return fallback;
}

function rankTickerRow(row: TickerUniverseRow, qUpper: string): number {
  const prefixBoost = String(row.ticker || "")
    .toUpperCase()
    .startsWith(qUpper)
    ? 1000
    : 0;
  const confidence = Number(row.metadata_confidence || 0) * 100;
  const sectorBoost = isSpecificSectorLabel(row.sector || row.sector_primary) ? 20 : 0;
  const exchangeBoost =
    toNonEmpty(row.exchange) && String(row.exchange).toLowerCase() !== "portfolio" ? 5 : 0;
  return prefixBoost + confidence + sectorBoost + exchangeBoost;
}

export function KaiCommandPalette({
  open,
  onOpenChange,
  onCommand,
  hasPortfolioData = true,
  portfolioTickers = [],
}: KaiCommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [universe, setUniverse] = useState<TickerUniverseRow[] | null>(
    getTickerUniverseSnapshot()
  );
  const [loadingUniverse, setLoadingUniverse] = useState<boolean>(!universe);
  const [remoteMatches, setRemoteMatches] = useState<TickerUniverseRow[]>([]);
  const [universeError, setUniverseError] = useState<string | null>(null);
  const [remoteSearchError, setRemoteSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setLoadingUniverse(false);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        setLoadingUniverse(true);
        setUniverseError(null);
        const rows = await preloadTickerUniverse();
        if (!cancelled) {
          setUniverse(rows);
        }
      } catch (error) {
        if (!cancelled) {
          setUniverse((prev) => prev ?? []);
          setUniverseError(
            error instanceof Error ? error.message : "Failed to load ticker universe"
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingUniverse(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setRemoteMatches([]);
      setRemoteSearchError(null);
      return;
    }

    let cancelled = false;
    const q = query.trim();
    if (q.length < 2) {
      setRemoteMatches([]);
      setRemoteSearchError(null);
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const rows = await searchTickerUniverseRemote(q, 20);
          if (!cancelled) {
            setRemoteMatches(rows);
            setRemoteSearchError(null);
          }
        } catch (error) {
          if (!cancelled) {
            setRemoteMatches([]);
            setRemoteSearchError(
              error instanceof Error ? error.message : "Ticker search failed"
            );
          }
        }
      })();
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const universeByTicker = useMemo(() => {
    const map = new Map<string, TickerUniverseRow>();
    const rows = universe ?? [];
    for (const row of rows) {
      const ticker = String(row.ticker || "").trim().toUpperCase();
      if (!ticker) continue;
      map.set(ticker, row);
    }
    return map;
  }, [universe]);

  const portfolioRows = useMemo<TickerUniverseRow[]>(() => {
    const deduped = new Map<string, TickerUniverseRow>();
    for (const row of portfolioTickers) {
      const symbol = String(row.symbol || "").trim().toUpperCase();
      if (!symbol) continue;
      if (!isPortfolioAnalyzeEligible(row)) continue;
      if (deduped.has(symbol)) continue;
      const enriched = universeByTicker.get(symbol);
      const preferredSector = pickPreferredLabel([
        enriched?.sector,
        enriched?.sector_primary,
        row.sector,
        row.asset_type,
      ]);
      deduped.set(symbol, {
        ticker: symbol,
        title:
          toNonEmpty(row.name) ||
          toNonEmpty(enriched?.title) ||
          "Portfolio holding",
        sector_primary: preferredSector,
        sector: preferredSector,
        industry_primary: toNonEmpty(enriched?.industry || enriched?.industry_primary),
        exchange: toNonEmpty(enriched?.exchange) || "Portfolio",
        metadata_confidence:
          typeof enriched?.metadata_confidence === "number"
            ? enriched.metadata_confidence
            : 1,
        tradable: true,
      });
    }
    return Array.from(deduped.values());
  }, [portfolioTickers, universeByTicker]);

  const portfolioTickerSet = useMemo(() => {
    return new Set(portfolioRows.map((row) => row.ticker));
  }, [portfolioRows]);

  const tickerMatches = useMemo(() => {
    const rows = universe ?? [];
    const search = query.trim();
    const mergeAndNormalizeRows = (
      candidates: TickerUniverseRow[],
      qUpper: string
    ): TickerUniverseRow[] => {
      const byTicker = new Map<string, TickerUniverseRow>();
      for (const row of candidates) {
        const ticker = String(row.ticker || "").trim().toUpperCase();
        if (!ticker) continue;
        const normalized: TickerUniverseRow = {
          ...row,
          ticker,
          sector: pickPreferredLabel([row.sector, row.sector_primary]),
          sector_primary: pickPreferredLabel([row.sector_primary, row.sector]),
        };
        const existing = byTicker.get(ticker);
        if (
          !existing ||
          rankTickerRow(normalized, qUpper) > rankTickerRow(existing, qUpper)
        ) {
          byTicker.set(ticker, normalized);
        }
      }
      return Array.from(byTicker.values()).filter((row) => row.tradable !== false);
    };

    if (!search) {
      const mergedDefaultRows = mergeAndNormalizeRows(
        [...portfolioRows, ...rows.filter((row) => isLikelySecCommonEquityRow(row))],
        ""
      );
      return mergedDefaultRows
        .sort((a, b) => {
          const aPortfolio = portfolioTickerSet.has(a.ticker) ? 1 : 0;
          const bPortfolio = portfolioTickerSet.has(b.ticker) ? 1 : 0;
          if (aPortfolio !== bPortfolio) return bPortfolio - aPortfolio;
          const aScore = Number(a.metadata_confidence || 0);
          const bScore = Number(b.metadata_confidence || 0);
          if (aScore !== bScore) return bScore - aScore;
          return a.ticker.localeCompare(b.ticker);
        })
        .slice(0, 20);
    }

    const searchUpper = search.toUpperCase();
    const portfolioMatches = portfolioRows.filter((row) => {
      const title = String(row.title || "").toLowerCase();
      return row.ticker.includes(searchUpper) || title.includes(search.toLowerCase());
    });
    const local = searchTickerUniverse(rows, search, 20).filter((row) =>
      isLikelySecCommonEquityRow(row)
    );
    const merged = [...portfolioMatches, ...local];
    for (const row of remoteMatches) {
      if (!isLikelySecCommonEquityRow(row)) continue;
      merged.push(row);
    }
    return mergeAndNormalizeRows(merged, searchUpper)
      .sort((a, b) => {
        const aPrefix = a.ticker.startsWith(searchUpper) ? 1 : 0;
        const bPrefix = b.ticker.startsWith(searchUpper) ? 1 : 0;
        if (aPrefix !== bPrefix) return bPrefix - aPrefix;
        const aScore = Number(a.metadata_confidence || 0);
        const bScore = Number(b.metadata_confidence || 0);
        if (aScore !== bScore) return bScore - aScore;
        return a.ticker.localeCompare(b.ticker);
      })
      .slice(0, 20);
  }, [portfolioRows, portfolioTickerSet, query, universe, remoteMatches]);

  const isFiltering = query.trim().length > 0;
  const commandEmptyMessage = loadingUniverse
    ? "Loading commands..."
    : universeError
      ? "Ticker universe unavailable. Check backend connectivity."
      : "No matching commands.";

  function run(command: KaiCommandAction, params?: Record<string, unknown>) {
    onOpenChange(false);
    setQuery("");
    onCommand(command, params);
  }

  const commandItemClass =
    "rounded-lg border border-transparent transition-colors duration-300 hover:bg-primary/10 hover:text-foreground data-[selected=true]:border-primary/25 data-[selected=true]:bg-primary/15 data-[selected=true]:text-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45";

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      className="top-[calc(var(--top-shell-reserved-height,0px)+0.75rem)] max-h-[min(70dvh,32rem)] w-[calc(100%-1rem)] translate-y-0 sm:top-1/2 sm:w-full sm:max-h-none sm:-translate-y-1/2"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Run Kai command or search ticker..."
      />
      <CommandList className="max-h-[min(56dvh,24rem)] sm:max-h-[300px]">
        <CommandEmpty>{commandEmptyMessage}</CommandEmpty>

        <CommandGroup heading="Portfolio Actions">
          <CommandItem className={commandItemClass} onSelect={() => run("dashboard")}>
            <Icon icon={BarChart3} size="sm" className="mr-2 text-muted-foreground" />
            Portfolio
          </CommandItem>
          {!isFiltering ? (
            <CommandItem className={commandItemClass} disabled>
              <Icon icon={Activity} size="sm" className="mr-2 text-muted-foreground" />
              <span>Optimize Portfolio</span>
              <span className="ml-auto text-xs text-muted-foreground">Coming soon</span>
            </CommandItem>
          ) : null}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Intelligence">
          <CommandItem
            className={commandItemClass}
            disabled={!hasPortfolioData}
            onSelect={() => run("history")}
          >
            <Icon icon={History} size="sm" className="mr-2 text-muted-foreground" />
            Analysis History
          </CommandItem>
          <CommandItem className={commandItemClass} onSelect={() => run("home")}>
            <Icon icon={Compass} size="sm" className="mr-2 text-muted-foreground" />
            Kai Home
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Account">
          <CommandItem className={commandItemClass} onSelect={() => run("consent")}>
            <Icon icon={ShieldCheck} size="sm" className="mr-2 text-muted-foreground" />
            Consents
          </CommandItem>
          <CommandItem className={commandItemClass} onSelect={() => run("profile")}>
            <Icon icon={UserRound} size="sm" className="mr-2 text-muted-foreground" />
            Profile
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Analyze Stock">
          {universeError ? (
            <CommandItem className={commandItemClass} disabled>
              Ticker universe unavailable.
            </CommandItem>
          ) : null}
          {remoteSearchError && isFiltering ? (
            <CommandItem className={commandItemClass} disabled>
              Live ticker search failed.
            </CommandItem>
          ) : null}
          {!loadingUniverse && tickerMatches.length === 0 && (
            <CommandItem className={commandItemClass} disabled>
              No matching SEC common equity tickers.
            </CommandItem>
          )}
          {tickerMatches.map((row) => {
            const ticker = row.ticker.toUpperCase();
            const title = row.title || "Unknown company";
            return (
              <CommandItem
                className={commandItemClass}
                key={`${ticker}:${title}`}
                value={`${ticker} ${title} ${row.sector || row.sector_primary || ""} ${row.exchange || ""}`}
                onSelect={() => run("analyze", { symbol: ticker })}
              >
                <Icon icon={Search} size="sm" className="mr-2 text-muted-foreground" />
                <span className="font-semibold">{ticker}</span>
                <span className="ml-2 text-xs text-muted-foreground truncate">
                  {title}
                  {row.sector || row.sector_primary
                    ? ` • ${row.sector || row.sector_primary}`
                    : ""}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
