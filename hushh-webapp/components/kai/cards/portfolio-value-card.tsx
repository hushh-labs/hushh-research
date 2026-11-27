"use client";

import type { ReactNode } from "react";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { ChevronRight } from "@/components/icons";
import { formatPlaidBalanceDate, type PortfolioImportLabel } from "@/components/kai/views/portfolio-display-facts";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import { cn } from "@/lib/utils";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
import { formatCurrency } from "@/lib/kai/market-value-format";
import { useMarketCurrency } from "@/lib/kai/use-market-currency";

export function PortfolioPlaidSyncDate({ syncedAt }: { syncedAt: string | null }) {
  const now = useCoarseClock(60_000);
  return formatPlaidBalanceDate(syncedAt, now);
}

export function PortfolioValueCard({ source, importLabel, value, invested, cash, change, changePct, period, action, onOpenPerformance }: {
  source: string;
  importLabel?: PortfolioImportLabel;
  value: number;
  invested: number | null;
  cash: number | null;
  change: number | null;
  changePct: number | null;
  period: ReactNode;
  action?: ReactNode;
  onOpenPerformance: () => void;
}) {
  useMarketCurrency();
  const valueLabel = importLabel === source ? "Portfolio value" : `${source} portfolio value`;
  return (
    <SurfaceCard data-testid="portfolio-value-card" className={styles.portfolioHero}>
      <SurfaceCardContent className={styles.portfolioHeroBody}>
        <div className={styles.portfolioTopHeader}>
          <p className={styles.portfolioHeroLabel}>{valueLabel}</p>
          {importLabel || action ? (
            <div className={styles.portfolioHeroControls}>
              {importLabel ? <span className={styles.portfolioSourceBadge} title="Portfolio source">{importLabel}</span> : null}
              {action}
            </div>
          ) : null}
        </div>
        <button type="button" aria-label="View performance" data-voice-control-id="show_portfolio_performance" className={styles.portfolioHeroAction} onClick={onOpenPerformance}>
          <span className={cn(styles.portfolioValue, "text-3xl sm:text-4xl")}>{formatCurrency(value)}</span>
          <span className={styles.portfolioHeroChevron} aria-hidden="true"><ChevronRight size={18} /></span>
        </button>
        {change !== null ? (
          <p className={styles.portfolioHeroMeta}>
            <span className={styles.portfolioHeroChange}>
              {change > 0 ? "+" : change < 0 ? "−" : ""}{formatCurrency(Math.abs(change))}
              {changePct !== null ? ` · ${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}%` : ""}
            </span>{" balance change"}
          </p>
        ) : null}
        <p className={styles.portfolioHeroMeta}>{period}</p>
        <dl className={styles.portfolioTotals} aria-label="Portfolio balance summary" role="group">
          <div>
            <dt>Invested</dt>
            <dd>{invested === null ? "Unavailable" : formatCurrency(invested)}</dd>
          </div>
          <div>
            <dt>Cash</dt>
            <dd>{cash === null ? "Unavailable" : formatCurrency(cash)}</dd>
          </div>
        </dl>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
