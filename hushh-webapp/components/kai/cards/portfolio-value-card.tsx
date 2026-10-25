"use client";

import type { ReactNode } from "react";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { PortfolioHistoryChart, type HistoricalDataPoint } from "@/components/kai/charts/portfolio-history-chart";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import { cn } from "@/lib/utils";

const money = (value: number | null) => value === null ? "Unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);

export function PortfolioValueCard({ source, value, change, changePct, period, history, action, invested, cash }: {
  source: string; value: number; change: number | null; changePct: number | null;
  period: string; history: HistoricalDataPoint[]; action?: ReactNode;
  invested?: number | null; cash?: number | null;
}) {
  return <SurfaceCard data-testid="portfolio-value-card" className={styles.detail}>
    <SurfaceCardContent className="space-y-5 p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <p className={styles.description}>{source} portfolio value</p>
        {action}
      </div>
      <div>
        <p className={styles.value}>{money(value)}</p>
        {change !== null ? <p className={cn("mt-2 text-sm font-medium tabular-nums", change > 0 ? "text-[var(--finance-positive)]" : change < 0 ? "text-[var(--finance-negative)]" : "text-muted-foreground")}>
          {change > 0 ? "+" : change < 0 ? "−" : ""}{money(Math.abs(change))}{changePct !== null ? ` · ${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}%` : ""}
        </p> : null}
        {change !== null ? <p className={cn(styles.description, "mt-1")}>Period balance change · includes cash flows</p> : null}
      </div>
      {history.length >= 2 ? <PortfolioHistoryChart data={history} height={220} /> : <p className={styles.description}>Balance snapshot · This source hasn’t supplied dated balance history.</p>}
      {invested !== undefined || cash !== undefined ? <dl className={styles.summaryFacts}>
        <div><dt>Invested</dt><dd>{money(invested ?? null)}</dd></div>
        <div><dt>Cash</dt><dd>{money(cash ?? null)}</dd></div>
      </dl> : null}
      <p className={styles.description}>{period}</p>
    </SurfaceCardContent>
  </SurfaceCard>;
}
