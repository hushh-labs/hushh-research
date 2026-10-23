"use client";

import type { ReactNode } from "react";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { PortfolioHistoryChart, type HistoricalDataPoint } from "@/components/kai/charts/portfolio-history-chart";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import { cn } from "@/lib/utils";

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);

export function PortfolioValueCard({ source, value, change, changePct, period, history, action }: {
  source: string; value: number; change: number; changePct: number;
  period: string; history: HistoricalDataPoint[]; action?: ReactNode;
}) {
  return <SurfaceCard data-testid="portfolio-value-card" className={styles.detail}>
    <SurfaceCardContent className="space-y-5 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs leading-[18px] text-muted-foreground">{source} portfolio value</p>
          <p className={cn(styles.value, "mt-2")}>{money(value)}</p>
          <p className={cn("mt-2 text-sm font-medium tabular-nums", change >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
            {change >= 0 ? "+" : "−"}{money(Math.abs(change))} · {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
          </p>
        </div>
        {action}
      </div>
      {history.length >= 2 ? <PortfolioHistoryChart data={history} height={220} /> : null}
      <p className="text-xs leading-[18px] text-muted-foreground">{period}</p>
    </SurfaceCardContent>
  </SurfaceCard>;
}
