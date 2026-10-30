"use client";

import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { cn } from "@/lib/utils";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatShares(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function formatSignedCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatCurrency(Math.abs(value))}`;
}

export interface HoldingMobileCardViewModel {
  id: string;
  symbol: string;
  name: string;
  marketValue: number;
  shares: number;
  gainLossValue: number | null;
  gainLossPct: number | null;
  averagePrice: number | null;
  currentPrice: number | null;
  portfolioWeightPct: number;
  sector: string | null;
  isCash: boolean;
  pendingDelete: boolean;
}

interface HoldingMobileCardProps {
  holding: HoldingMobileCardViewModel;
  onOpen: () => void;
}

export function HoldingMobileCard({
  holding,
  onOpen,
}: HoldingMobileCardProps) {
  const gainLossTone =
    holding.gainLossPct === null
      ? "text-muted-foreground"
      : holding.gainLossPct > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : holding.gainLossPct < 0
      ? "text-rose-600 dark:text-rose-400"
      : "text-muted-foreground";

  const averagePriceText =
    holding.averagePrice !== null ? formatCurrency(holding.averagePrice) : "N/A";

  return (
    <div
      className={cn(
        "rounded-xl border border-border/60 bg-background/70 px-2 py-1.5 shadow-[0_8px_24px_rgba(15,23,42,0.08)] sm:px-3 sm:py-2",
        holding.pendingDelete && "opacity-60"
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="min-h-0 w-full text-left outline-none transition-opacity hover:opacity-95 focus-visible:ring-2 focus-visible:ring-ring/60 rounded-lg p-0.5"
        aria-label={`Open holding details for ${holding.symbol}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <SymbolAvatar
              symbol={holding.symbol}
              name={holding.name}
              isCash={holding.isCash}
              size="sm"
              className={holding.pendingDelete ? "line-through" : undefined}
            />

            <div className="min-w-0">
              <p
                className={cn(
                  "app-card-title truncate uppercase text-foreground",
                  holding.pendingDelete && "line-through"
                )}
                title={holding.symbol || "—"}
              >
                {holding.symbol || "—"}
              </p>
              <p
                className={cn(
                  "app-body-text truncate text-muted-foreground",
                  holding.pendingDelete && "line-through"
                )}
                title={holding.name || "Unnamed security"}
              >
                {holding.name || "Unnamed security"}
              </p>
              <p
                className={cn(
                  "app-label-text mt-0.5 truncate text-muted-foreground",
                  holding.pendingDelete && "line-through"
                )}
              >
                {formatShares(holding.shares)} shares · avg {averagePriceText}
              </p>
            </div>
          </div>

          <div className="w-[8.9rem] shrink-0 text-right tabular-nums sm:w-[9.25rem]">
            <p
              className={cn(
                "app-card-title text-foreground",
                holding.pendingDelete && "line-through"
              )}
            >
              {formatCurrency(holding.marketValue)}
            </p>
            <p className={cn("app-feature-point", gainLossTone, holding.pendingDelete && "line-through")}>
              {formatSignedCurrency(holding.gainLossValue)}
              {holding.gainLossPct !== null ? ` · ${formatSignedPercent(holding.gainLossPct)}` : ""}
            </p>
          </div>
        </div>
      </button>
    </div>
  );
}
