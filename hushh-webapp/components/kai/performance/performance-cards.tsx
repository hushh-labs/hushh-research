"use client";

import { useState } from "react";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { ChevronRight } from "@/components/icons";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import type {
  ConcentrationDatum,
  DashboardSummaryMetrics,
  GainLossBandDatum,
} from "@/components/kai/views/dashboard-data-mapper";
import type { DashboardPosition } from "@/components/kai/views/dashboard-portfolio-model";
import {
  concentrationSummary,
  rankMovers,
  winnersLosers,
} from "@/lib/kai/portfolio-performance";
import { cn } from "@/lib/utils";
import { money, signedMoney, signedPercent, tone } from "./performance-strip";
import styles from "./portfolio-performance.module.css";

import { useMarketCurrency } from "@/lib/kai/use-market-currency";
export function ConcentrationCard({ data, label }: { data: readonly ConcentrationDatum[]; label: string }) {
  useMarketCurrency();
  if (!data.length) return null;
  const summary = concentrationSummary(data);
  const widest = Math.max(...data.map((row) => row.weightPct), 0.01);
  return (
    <SurfaceCard className={cn("min-w-0", financeStyles.detail)} aria-label="Concentration">
      <SurfaceCardContent className={cn(financeStyles.insightCard, "h-full")}>
        <p className="ui-text-section-label">
          Concentration
          {label && label !== "Unknown" ? <span className={styles.chip}>{label}</span> : null}
        </p>
        <p className={styles.amount}>Top {summary.count} · {summary.topPct.toFixed(1)}%</p>
        <div className={styles.rows}>
          {data.map((row) => (
            <div key={row.symbol} className={styles.row}>
              <span className={styles.rowLabel} title={row.name}>{row.symbol}</span>
              <span className={styles.track} aria-hidden="true"><span className={styles.fill} style={{ width: `${(row.weightPct / widest) * 100}%` }} /></span>
              <span className={styles.end}>
                <span className={cn("block", styles.rowLabel, styles.number)}>{row.weightPct.toFixed(1)}%</span>
                <span className={cn("block", styles.label, styles.number)}>{money(row.marketValue)}</span>
              </span>
            </div>
          ))}
        </div>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

export function WinnersLosersCard({ bands }: { bands: readonly GainLossBandDatum[] }) {
  useMarketCurrency();
  const summary = winnersLosers(bands);
  if (summary.total === 0) return null;
  return (
    <SurfaceCard className={cn("min-w-0", financeStyles.detail)} aria-label="Winners and losers">
      <SurfaceCardContent className={financeStyles.insightCard}>
        <p className="ui-text-section-label">Winners and losers</p>
        <p className={styles.amount}>{summary.down} down · {summary.flat} flat · {summary.up} up</p>
        <div className={styles.split} role="img" aria-label={`${summary.down} down, ${summary.flat} flat, ${summary.up} up`}>
          {summary.segments.filter((segment) => segment.count > 0).map((segment) => (
            <span key={segment.tone} className={styles[segment.tone]} style={{ flex: segment.count }} />
          ))}
        </div>
        <div className={styles.legend}>
          {summary.segments.map((segment) => (
            <div key={segment.tone}>
              <span><i className={cn(styles.dot, styles[segment.tone])} />{segment.label}</span>
              <b>{segment.count}</b>
            </div>
          ))}
        </div>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function MoverRow({ position, onOpen, className }: { position: DashboardPosition; onOpen: () => void; className?: string }) {
  const gain = position.gainLoss ?? 0;
  return (
    <button type="button" aria-haspopup="dialog" className={cn(styles.mover, financeStyles.interactiveRow, "relative isolate", className)} onClick={onOpen}>
      <SymbolAvatar symbol={position.displaySymbol} name={position.name} size="md" className="size-8 rounded-lg" />
      <span className="min-w-0">
        <span className={cn("block truncate", styles.rowLabel)}>{position.displaySymbol}</span>
        {position.name && position.name !== position.displaySymbol ? <span className={cn("block truncate", styles.label)}>{position.name}</span> : null}
      </span>
      <span className={styles.end}>
        <span className={cn("block", styles.rowLabel, styles.number, tone(gain))}>{signedMoney(gain)}</span>
        {position.gainLossPct !== null ? <span className={cn("block", styles.label, styles.number)}>{signedPercent(position.gainLossPct)}</span> : null}
      </span>
    </button>
  );
}

/** One biggest gain and one biggest loss. Tapping opens the top three of each; each row opens that holding. */
export function BiggestMoversCard({ positions, onOpenHolding }: { positions: readonly DashboardPosition[]; onOpenHolding: (id: string) => void }) {
  useMarketCurrency();
  const [open, setOpen] = useState(false);
  const { gains, losses } = rankMovers(positions, 3);
  if (!gains.length && !losses.length) return null;
  const preview = [gains[0], losses[0]].filter((position): position is DashboardPosition => Boolean(position));
  const choose = (id: string) => { setOpen(false); onOpenHolding(id); };
  return (
    <>
      <SurfaceCard className={cn("min-w-0", styles.grow, financeStyles.detail)}>
        <SurfaceCardContent className={cn(financeStyles.insightCard, "h-full")}>
          <button type="button" aria-haspopup="dialog" className={styles.moversHead} onClick={() => setOpen(true)} aria-label="Biggest gain and loss: show the top three of each">
            <span className="ui-text-section-label">Biggest gain and loss</span>
            <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
          </button>
          <div className={styles.movers}>
            {preview.map((position) => <MoverRow key={position.id} position={position} onOpen={() => onOpenHolding(position.id)} />)}
          </div>
        </SurfaceCardContent>
      </SurfaceCard>
      <KaiControlSurface open={open} onOpenChange={setOpen} title="Biggest gains and losses" presentation="sheet" surfaceClassName={financeStyles.detail}>
        {gains.length ? <p className={cn(styles.sheetSection, styles.positive)}>Gains</p> : null}
        {gains.map((position) => <MoverRow key={position.id} position={position} className={styles.sheetRow} onOpen={() => choose(position.id)} />)}
        {losses.length ? <p className={cn(styles.sheetSection, styles.negative)}>Losses</p> : null}
        {losses.map((position) => <MoverRow key={position.id} position={position} className={styles.sheetRow} onOpen={() => choose(position.id)} />)}
      </KaiControlSurface>
    </>
  );
}

/** Statement income and fees. Only what the statement reports is shown. */
export function IncomeFeesCard({ metrics }: { metrics: DashboardSummaryMetrics }) {
  useMarketCurrency();
  const tiles: Array<{ label: string; value: number; signed: boolean }> = [];
  const add = (label: string, value: number | null, signed = true) => { if (typeof value === "number" && Number.isFinite(value)) tiles.push({ label, value, signed }); };
  add("Income", metrics.totalIncomePeriod);
  add("Income this year", metrics.totalIncomeYtd);
  add("Fees", metrics.totalFees === null ? null : -Math.abs(metrics.totalFees));
  add("Investment results", metrics.investmentGainLoss);
  add("Net deposits", metrics.netDepositsPeriod);
  if (!tiles.length) return null;
  return (
    <SurfaceCard className={cn("min-w-0", financeStyles.detail)} aria-label="Income and fees">
      <SurfaceCardContent className={financeStyles.insightCard}>
        <p className="ui-text-section-label">Income and fees</p>
        <dl className={styles.tiles}>
          {tiles.map((tile) => (
            <div key={tile.label}>
              <dt>{tile.label}</dt>
              <dd className={tone(tile.value)}>{signedMoney(tile.value)}</dd>
            </div>
          ))}
        </dl>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

/** Concentration beside winners and losers plus the movers card, then income and fees. */
export function PortfolioDetailCards({ concentration, concentrationLabel, bands, positions, metrics, showStatementMetrics, onOpenHolding }: {
  concentration: readonly ConcentrationDatum[];
  concentrationLabel: string;
  bands: readonly GainLossBandDatum[];
  positions: readonly DashboardPosition[];
  metrics: DashboardSummaryMetrics;
  showStatementMetrics: boolean;
  onOpenHolding: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className={styles.grid}>
        <ConcentrationCard data={concentration} label={concentrationLabel} />
        <div className={styles.column}>
          <WinnersLosersCard bands={bands} />
          <BiggestMoversCard positions={positions} onOpenHolding={onOpenHolding} />
        </div>
      </div>
      {showStatementMetrics ? <IncomeFeesCard metrics={metrics} /> : null}
    </div>
  );
}
