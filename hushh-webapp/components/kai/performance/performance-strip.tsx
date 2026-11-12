"use client";

import type { CSSProperties, ReactNode } from "react";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import type { SinceBought } from "@/lib/kai/portfolio-performance";
import { cn } from "@/lib/utils";
import styles from "./portfolio-performance.module.css";

import { formatCurrency, formatCurrencyWhole } from "@/lib/kai/market-value-format";
import { useMarketCurrency } from "@/lib/kai/use-market-currency";
export const money = (value: number) => formatCurrencyWhole(value);
export const signedMoney = (value: number) => `${value < 0 ? "−" : "+"}${formatCurrencyWhole(Math.abs(value))}`;
export const signedPercent = (value: number) => `${value < 0 ? "−" : "+"}${Math.abs(value).toFixed(1)}%`;
export const tone = (value: number) => (value < 0 ? styles.negative : value > 0 ? styles.positive : undefined);

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.stat}>
      <p className={styles.label}>{label}</p>
      <p className={styles.amount}>{children}</p>
    </div>
  );
}

/** Value, change since purchase, invested and cash on one line. A stat with no value is left out. */
export function PerformanceStrip({ value, sinceBought, invested, cash, period }: {
  value: number;
  sinceBought: SinceBought | null;
  invested: number | null;
  cash: number | null;
  period: string;
}) {
  useMarketCurrency();
  const stats = [
    <Stat key="value" label="Portfolio value">{formatCurrency(value)}</Stat>,
    sinceBought ? (
      <Stat key="since" label="Since you bought">
        <span className={tone(sinceBought.gain)}>
          {signedMoney(sinceBought.gain)}
          {sinceBought.pct !== null ? ` · ${signedPercent(sinceBought.pct)}` : ""}
        </span>
      </Stat>
    ) : null,
    invested !== null ? <Stat key="invested" label="Invested">{money(invested)}</Stat> : null,
    cash !== null ? <Stat key="cash" label="Cash">{money(cash)}</Stat> : null,
  ].filter(Boolean);
  return (
    <SurfaceCard data-testid="performance-strip" className={financeStyles.detail}>
      <SurfaceCardContent className="p-4">
        <div className={styles.strip} style={{ "--stats": stats.length } as CSSProperties}>{stats}</div>
        <p className={cn(styles.label, styles.period)}>{period}</p>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
