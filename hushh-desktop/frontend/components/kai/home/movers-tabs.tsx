"use client";

import { useMemo, useState } from "react";

import type { KaiHomeMover, KaiHomeMovers } from "@/lib/services/api-service";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { cn } from "@/lib/utils";

type MoversTabKey = "gainers" | "losers" | "active";

interface MoversTabsProps {
  movers?: KaiHomeMovers;
}

const TABS: Array<{ key: MoversTabKey; label: string }> = [
  { key: "gainers", label: "Gainers" },
  { key: "losers", label: "Losers" },
  { key: "active", label: "Active" },
];

function formatRowChange(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function MoversList({ rows }: { rows: KaiHomeMover[] }) {
  if (!rows.length) {
    return <p className="text-sm text-muted-foreground">Market data is unavailable right now.</p>;
  }

  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const positive = typeof row.change_pct === "number" && row.change_pct >= 0;
        return (
          <div key={`${row.symbol}-${row.volume || 0}`} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/60 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{row.symbol}</p>
              <p className="truncate text-[11px] text-muted-foreground">{row.company_name}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold">{typeof row.price === "number" ? row.price.toFixed(2) : "--"}</p>
              <p className={cn("text-xs font-semibold", positive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>{formatRowChange(row.change_pct)}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function MoversTabs({ movers }: MoversTabsProps) {
  const [tab, setTab] = useState<MoversTabKey>("gainers");

  const rows = useMemo(() => {
    if (!movers) return [];
    return (movers[tab] || []).slice(0, 6);
  }, [movers, tab]);

  return (
    <Card variant="none" effect="glass" preset="compact">
      <CardContent className="space-y-3 p-4">
        <p className="text-sm font-semibold tracking-tight">Market Movers</p>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {TABS.map((item) => (
            <button
              type="button"
              key={item.key}
              onClick={() => setTab(item.key)}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                tab === item.key ? "bg-foreground text-background" : "bg-muted text-muted-foreground"
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <MoversList rows={rows} />
      </CardContent>
    </Card>
  );
}
