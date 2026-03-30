"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { Input } from "@/components/ui/input";
import type { Holding as PortfolioHolding } from "@/components/kai/types/portfolio";
import {
  HoldingMobileCard,
  type HoldingMobileCardViewModel,
} from "@/components/kai/holdings/holding-mobile-card";
import { HoldingDetailsDrawer } from "@/components/kai/holdings/holding-details-drawer";
import { cn } from "@/lib/utils";

type HoldingsFilter = "all" | "winners" | "losers" | "cash";

export type HoldingsListItem = PortfolioHolding & {
  client_id: string;
  pending_delete?: boolean;
};

interface HoldingsMobileListProps {
  holdings: HoldingsListItem[];
  canManageHoldings?: boolean;
  onEditHolding: (holdingId: string) => void;
  onToggleDeleteHolding: (holdingId: string) => void;
}

function toFiniteNumber(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function resolveGainLossValue(holding: HoldingsListItem): number | null {
  const explicit = toFiniteNumber(holding.unrealized_gain_loss);
  if (explicit !== null) return explicit;
  const marketValue = toFiniteNumber(holding.market_value);
  const costBasis = toFiniteNumber(holding.cost_basis);
  if (marketValue !== null && costBasis !== null) return marketValue - costBasis;
  return null;
}

function resolveGainLossPct(holding: HoldingsListItem, gainLossValue: number | null): number | null {
  const explicitPct = toFiniteNumber(holding.unrealized_gain_loss_pct);
  if (explicitPct !== null) return explicitPct;
  const costBasis = toFiniteNumber(holding.cost_basis);
  if (gainLossValue !== null && costBasis !== null && costBasis !== 0) {
    return (gainLossValue / costBasis) * 100;
  }
  return null;
}

function resolveAveragePrice(holding: HoldingsListItem): number | null {
  const quantity = toFiniteNumber(holding.quantity);
  const costBasis = toFiniteNumber(holding.cost_basis);
  if (costBasis !== null && quantity !== null && quantity > 0) {
    return costBasis / quantity;
  }
  return toFiniteNumber(holding.price);
}

function resolveCurrentPrice(holding: HoldingsListItem): number | null {
  return toFiniteNumber(holding.price);
}

function resolveWeightPct(holding: HoldingsListItem, totalMarketValue: number): number {
  const marketValue = toFiniteNumber(holding.market_value) || 0;
  if (totalMarketValue <= 0) return 0;
  return (marketValue / totalMarketValue) * 100;
}

function resolveSector(holding: HoldingsListItem): string | null {
  const raw = String(holding.sector || holding.asset_type || holding.asset_class || "").trim();
  return raw.length > 0 ? raw : null;
}

function holdingDirection(holding: HoldingMobileCardViewModel): number {
  if (holding.gainLossPct !== null) {
    if (holding.gainLossPct > 0) return 1;
    if (holding.gainLossPct < 0) return -1;
  }
  if (holding.gainLossValue !== null) {
    if (holding.gainLossValue > 0) return 1;
    if (holding.gainLossValue < 0) return -1;
  }
  return 0;
}

function toCardViewModel(holding: HoldingsListItem, totalMarketValue: number): HoldingMobileCardViewModel {
  const marketValue = toFiniteNumber(holding.market_value) || 0;
  const shares = toFiniteNumber(holding.quantity) || 0;
  const gainLossValue = resolveGainLossValue(holding);
  const gainLossPct = resolveGainLossPct(holding, gainLossValue);

  return {
    id: holding.client_id,
    symbol: String(holding.symbol || "").trim() || "—",
    name: String(holding.name || "").trim() || "Unnamed security",
    marketValue,
    shares,
    gainLossValue,
    gainLossPct,
    averagePrice: resolveAveragePrice(holding),
    currentPrice: resolveCurrentPrice(holding),
    portfolioWeightPct: resolveWeightPct(holding, totalMarketValue),
    sector: resolveSector(holding),
    isCash: holding.is_cash_equivalent === true,
    pendingDelete: Boolean(holding.pending_delete),
  };
}

const FILTERS: Array<{ key: HoldingsFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "winners", label: "Winners" },
  { key: "losers", label: "Losers" },
  { key: "cash", label: "Cash" },
];
const ESTIMATED_CARD_HEIGHT = 72;

export function HoldingsMobileList({
  holdings,
  canManageHoldings = true,
  onEditHolding,
  onToggleDeleteHolding,
}: HoldingsMobileListProps) {
  const [activeFilter, setActiveFilter] = useState<HoldingsFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedHoldingId, setSelectedHoldingId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const totalMarketValue = useMemo(() => {
    const activeTotal = holdings
      .filter((holding) => !holding.pending_delete)
      .reduce((sum, holding) => sum + (toFiniteNumber(holding.market_value) || 0), 0);
    if (activeTotal > 0) return activeTotal;
    return holdings.reduce((sum, holding) => sum + (toFiniteNumber(holding.market_value) || 0), 0);
  }, [holdings]);

  const holdingsViewModels = useMemo(
    () =>
      holdings
        .map((holding) => toCardViewModel(holding, totalMarketValue))
        .sort((a, b) => {
          if (b.portfolioWeightPct !== a.portfolioWeightPct) {
            return b.portfolioWeightPct - a.portfolioWeightPct;
          }
          if (b.marketValue !== a.marketValue) {
            return b.marketValue - a.marketValue;
          }
          return a.symbol.localeCompare(b.symbol, undefined, {
            sensitivity: "base",
            numeric: true,
          });
        }),
    [holdings, totalMarketValue]
  );

  const filterCounts = useMemo(() => {
    let winners = 0;
    let losers = 0;
    let cash = 0;
    for (const holding of holdingsViewModels) {
      const direction = holdingDirection(holding);
      if (direction > 0) winners += 1;
      if (direction < 0) losers += 1;
      if (holding.isCash) cash += 1;
    }
    return {
      all: holdingsViewModels.length,
      winners,
      losers,
      cash,
    };
  }, [holdingsViewModels]);

  const filteredHoldings = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    return holdingsViewModels.filter((holding) => {
      if (activeFilter === "winners" && holdingDirection(holding) <= 0) return false;
      if (activeFilter === "losers" && holdingDirection(holding) >= 0) return false;
      if (activeFilter === "cash" && !holding.isCash) return false;

      if (!query) return true;
      return (
        holding.symbol.toLowerCase().includes(query) ||
        holding.name.toLowerCase().includes(query)
      );
    });
  }, [activeFilter, holdingsViewModels, searchTerm]);

  const virtualizer = useVirtualizer({
    count: filteredHoldings.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ESTIMATED_CARD_HEIGHT,
    gap: 6,
    overscan: 5,
  });

  const selectedHolding = useMemo(
    () => holdingsViewModels.find((holding) => holding.id === selectedHoldingId) || null,
    [holdingsViewModels, selectedHoldingId]
  );

  useEffect(() => {
    if (!selectedHoldingId) return;
    if (holdingsViewModels.some((holding) => holding.id === selectedHoldingId)) return;
    setSelectedHoldingId(null);
  }, [holdingsViewModels, selectedHoldingId]);

  // Reset scroll on filter/search change
  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [activeFilter, searchTerm, virtualizer]);

  return (
    <>
      <div className="space-y-3">
        <div className="grid h-10 w-full grid-cols-4 gap-1 rounded-xl bg-background/80 p-0.5">
          {FILTERS.map((filter) => {
            const selected = activeFilter === filter.key;
            return (
              <button
                key={filter.key}
                type="button"
                onClick={() => setActiveFilter(filter.key)}
                className={cn(
                  "app-button-text h-9 rounded-lg px-1 leading-none transition-colors",
                  selected
                    ? "app-button-black"
                    : "text-muted-foreground hover:text-foreground"
                )}
                aria-pressed={selected}
              >
                {filter.label} ({filterCounts[filter.key]})
              </button>
            );
          })}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search holdings by ticker or company"
            className="app-body-text h-10 rounded-full border-border/60 bg-background/70 pl-9 pr-4 text-sm"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        {filteredHoldings.length > 0 ? (
          <>
            <p className="app-label-text text-muted-foreground text-right">
              {filteredHoldings.length} holding{filteredHoldings.length !== 1 ? "s" : ""}
            </p>
            <div
              ref={scrollContainerRef}
              className="-mx-1 max-h-[60vh] overflow-y-auto overscroll-contain rounded-xl px-1 sm:mx-0 sm:px-0"
              style={{ contain: "strict" }}
            >
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  width: "100%",
                  position: "relative",
                }}
              >
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const holding = filteredHoldings[virtualItem.index]!;
                  return (
                    <div
                      key={holding.id}
                      data-index={virtualItem.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <HoldingMobileCard
                        holding={holding}
                        onOpen={() => setSelectedHoldingId(holding.id)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-border/60 bg-background/50 px-4 py-6 text-center text-sm text-muted-foreground">
            No holdings match this filter.
          </div>
        )}
      </div>

      <HoldingDetailsDrawer
        open={Boolean(selectedHolding)}
        holding={selectedHolding}
        canManageHoldings={canManageHoldings}
        onOpenChange={(open) => {
          if (!open) setSelectedHoldingId(null);
        }}
        onEdit={() => {
          if (!selectedHolding) return;
          onEditHolding(selectedHolding.id);
          setSelectedHoldingId(null);
        }}
        onToggleDelete={() => {
          if (!selectedHolding) return;
          onToggleDeleteHolding(selectedHolding.id);
          setSelectedHoldingId(null);
        }}
      />
    </>
  );
}
