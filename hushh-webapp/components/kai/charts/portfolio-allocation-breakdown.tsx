"use client";

import type { PortfolioAllocationDatum } from "./portfolio-allocation-bar";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import { allocationColor } from "@/lib/kai/allocation-colors";
import { formatCurrency, formatCurrencyShort } from "@/lib/kai/market-value-format";
import { useMarketCurrency } from "@/lib/kai/use-market-currency";
import { cn } from "@/lib/utils";

interface PortfolioAllocationBreakdownProps {
  data: PortfolioAllocationDatum[];
  totalValue: number;
  selectedName?: string | null;
  onSelectionChange: (name: string | null) => void;
}

export function PortfolioAllocationBreakdown({
  data,
  totalValue,
  selectedName,
  onSelectionChange,
}: PortfolioAllocationBreakdownProps) {
  useMarketCurrency();
  const allocations = data.filter(({ value }) => Number.isFinite(value) && value > 0);
  const allocated = allocations.reduce((sum, { value }) => sum + value, 0);
  const hasReportedTotal = Number.isFinite(totalValue) && totalValue > 0;
  const total = hasReportedTotal ? totalValue : allocated;
  const segments = allocations.map(({ name, value }) => ({
    name,
    value,
    color: allocationColor(name),
    percent: value / total * 100,
  }));

  if (segments.length === 0 || !Number.isFinite(total)) {
    return <p className={styles.description}>Allocation is unavailable for this source.</p>;
  }

  const canShowRing = allocated <= total * 1.001;
  const stops: string[] = [];
  let end = 0;
  for (const { color, value } of segments) {
    const start = end;
    end = Math.min(100, start + value / Math.max(total, allocated) * 100);
    const gap = segments.length === 1 ? 0 : Math.min(0.8, (end - start) / 10);
    stops.push(`${color} ${start}% ${end - gap}%`, `var(--muted) ${end - gap}% ${end}%`);
  }
  if (end < 100) stops.push(`var(--muted) ${end}% 100%`);

  return (
    <div className={styles.portfolioBreakdown}>
      {canShowRing ? (
        <div className={cn(styles.allocationRing, styles.allocationGlow)} style={{ background: `conic-gradient(from -90deg, ${stops.join(", ")})` }}>
          <div className={styles.allocationRingCenter}>
            <strong title={formatCurrency(total)}>
              <span aria-hidden="true">{formatCurrencyShort(total)}</span>
              <span className="sr-only">{formatCurrency(total)}</span>
            </strong>
            <span className={styles.description}>{hasReportedTotal ? "Portfolio value" : "Allocated value"}</span>
          </div>
        </div>
      ) : (
        <p className={styles.description}>Reported category amounts exceed the portfolio value.</p>
      )}
      <ul className={styles.breakdownRows} aria-label="Asset breakdown">
        {segments.map(({ name, value, color, percent }) => {
          const selected = selectedName === name;
          return (
            <li key={name}>
              <button
                type="button"
                className={cn(styles.breakdownRow, styles.interactiveRow, "relative isolate")}
                data-finance-selected={selected || undefined}
                aria-pressed={selected}
                onClick={() => onSelectionChange(selected ? null : name)}
              >
                <span className={styles.breakdownRowHeader}>
                  <span className={styles.breakdownCategory}>
                    <span className={styles.allocationDot} style={{ backgroundColor: color }} aria-hidden="true" />
                    {name}
                  </span>
                  <span className={styles.breakdownAmount}>{formatCurrency(value)}</span>
                </span>
                <span className={styles.description}>{percent.toFixed(1)}% {hasReportedTotal ? "of portfolio" : "of allocated value"}</span>
                <span className={styles.breakdownTrack} aria-hidden="true">
                  <span style={{ width: `${Math.min(100, percent)}%`, color }} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
