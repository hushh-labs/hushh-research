"use client";

import { Card, CardContent } from "@/lib/morphy-ux/card";
import type { KaiHomeWatchlistItem } from "@/lib/services/api-service";
import { cn } from "@/lib/utils";

interface WatchlistStripProps {
  items: KaiHomeWatchlistItem[];
}

function formatCurrency(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

export function WatchlistStrip({ items }: WatchlistStripProps) {
  if (!items.length) {
    return (
      <Card variant="muted" effect="fill" preset="compact">
        <CardContent className="p-4 text-sm text-muted-foreground">
          No watchlist/holdings data available yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="-mx-4 overflow-x-auto overflow-y-visible px-6 py-3">
      <div className="flex min-w-0 gap-3">
        {items.map((item) => {
          const positive = typeof item.change_pct === "number" && item.change_pct >= 0;
          return (
            <Card
              key={item.symbol}
              variant="none"
              effect="glass"
              preset="compact"
              className="w-[182px] shrink-0"
            >
              <CardContent className="space-y-2 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{item.symbol}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{item.company_name}</p>
                  </div>
                  <span
                    className="rounded-full bg-background/70 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-foreground/80"
                  >
                    {item.recommendation}
                  </span>
                </div>

                <div>
                  <p className="text-base font-semibold tracking-tight">{formatCurrency(item.price)}</p>
                  <p
                    className={cn(
                      "text-xs font-semibold",
                      positive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
                    )}
                  >
                    {typeof item.change_pct === "number" ? `${item.change_pct >= 0 ? "+" : ""}${item.change_pct.toFixed(2)}%` : "--"}
                  </p>
                </div>

              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
