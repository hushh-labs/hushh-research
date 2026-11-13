"use client";

import type { CSSProperties, ReactNode } from "react";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import type { SinceBought } from "@/lib/kai/portfolio-performance";
import styles from "./portfolio-performance.module.css";

const wholeDollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const dollarsAndCents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export const money = (value: number) => wholeDollars.format(value);
export const signedMoney = (value: number) => `${value < 0 ? "−" : "+"}${wholeDollars.format(Math.abs(value))}`;
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
export function PerformanceStrip({ value, sinceBought, invested, cash }: {
  value: number;
  sinceBought: SinceBought | null;
  invested: number | null;
  cash: number | null;
  period: string;
}) {
  const stats = [
    <Stat key="value" label="Portfolio value">{dollarsAndCents.format(value)}</Stat>,
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
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
