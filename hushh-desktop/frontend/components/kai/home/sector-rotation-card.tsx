"use client";

import { Card, CardContent } from "@/lib/morphy-ux/card";
import type { KaiHomeSectorItem } from "@/lib/services/api-service";
import { cn } from "@/lib/utils";

interface SectorRotationCardProps {
  rows: KaiHomeSectorItem[];
}

export function SectorRotationCard({ rows }: SectorRotationCardProps) {
  if (!rows.length) {
    return (
      <Card variant="muted" effect="fill" preset="compact">
        <CardContent className="p-4 text-sm text-muted-foreground">
          Sector movement data is unavailable right now.
        </CardContent>
      </Card>
    );
  }

  const maxAbs = Math.max(
    0.01,
    ...rows.map((row) => Math.abs(typeof row.change_pct === "number" ? row.change_pct : 0))
  );

  return (
    <Card variant="none" effect="glass" preset="compact">
      <CardContent className="space-y-3 p-4">
        <p className="text-sm font-semibold tracking-tight">Sector Rotation</p>
        <div className="space-y-2">
          {rows.slice(0, 6).map((row) => {
            const pct = typeof row.change_pct === "number" ? row.change_pct : 0;
            const width = Math.min(100, Math.round((Math.abs(pct) / maxAbs) * 100));
            const positive = pct >= 0;
            return (
              <div key={row.sector} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-semibold">{row.sector}</span>
                  <span className={cn("font-semibold", positive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                    {typeof row.change_pct === "number" ? `${positive ? "+" : ""}${row.change_pct.toFixed(2)}%` : "--"}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", positive ? "bg-emerald-500" : "bg-rose-500")}
                    style={{ width: `${width}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

      </CardContent>
    </Card>
  );
}
