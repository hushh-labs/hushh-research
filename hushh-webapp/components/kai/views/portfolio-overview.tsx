"use client";

import { useState, type ReactNode } from "react";
import { Pie, PieChart, Cell } from "recharts";
import { SectionLabel } from "@/components/app-ui/typography";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { PortfolioValueCard } from "@/components/kai/cards/portfolio-value-card";
import type { StockHistoryLoader } from "@/components/kai/charts/stock-history-panel";
import { HoldingDetailsDrawer } from "@/components/kai/holdings/holding-details-drawer";
import { toHoldingViewModel } from "@/components/kai/holdings/holding-view-model";
import { groupHoldingPositions } from "@/lib/kai/holding-positions";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/kai/market-value-format";
import { allocationColor } from "@/lib/kai/allocation-colors";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import type { DashboardViewModel } from "./dashboard-data-mapper";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import type { KaiPortfolioSection } from "@/lib/navigation/routes";
import { overviewFacts } from "./portfolio-display-facts";
import { signedMoney, signedPercent, tone } from "@/components/kai/performance/performance-strip";
import { rankMovers, sinceBought, winnersLosers } from "@/lib/kai/portfolio-performance";

import { useMarketCurrency } from "@/lib/kai/use-market-currency";
export function PortfolioOverview({ model, portfolio, source, period, action, briefing, sharing, valuationKind, loadHistory, onImport, onOpenSection }: {
  model: DashboardViewModel; portfolio: PortfolioData; source: string;
  valuationKind?: "statement" | "linked"; loadHistory?: StockHistoryLoader;
  period: string; action?: ReactNode; briefing?: ReactNode; sharing?: ReactNode; onImport?: () => void; onOpenSection: (section: KaiPortfolioSection) => void;
}) {
  useMarketCurrency();
  const [selectedHoldingId, setSelectedHoldingId] = useState<string | null>(null);
  const facts = overviewFacts(model, portfolio);
  const positions = [...model.canonicalModel.positions].filter(position => !position.isCashEquivalent && position.marketValue > 0).sort((a, b) => b.marketValue - a.marketValue);
  const selectedHolding = selectedHoldingId === null ? undefined : groupHoldingPositions(portfolio.holdings ?? [])
    .find(position => position.client_id === selectedHoldingId);
  const selectedEntries = selectedHolding?.entries.map((entry, index) => ({
    ...entry, client_id: entry.entry_id ?? String(index),
  }));
  const since = sinceBought(model.canonicalModel.positions);
  const distribution = winnersLosers(model.gainLossDistribution);
  const movers = rankMovers(model.canonicalModel.positions, 1);
  const colors = ["var(--finance-negative)", "color-mix(in srgb, var(--finance-negative) 50%, transparent)", "var(--chart-4)", "color-mix(in srgb, var(--finance-positive) 50%, transparent)", "var(--finance-positive)"];
  const metrics = model.summaryMetrics;
  const reported = (label: string, value: number | null) => typeof value === "number" && Number.isFinite(value) ? [{ label, value: formatCurrency(value) }] : [];
  const performanceRows = [
    ...reported("Reported balance change", facts.change),
    ...reported("Income", metrics.totalIncomePeriod),
    ...reported("Fees", metrics.totalFees === null ? null : -Math.abs(metrics.totalFees)),
  ];
  const totalValue = model.hero.totalValue;
  const allocations = model.allocation.filter(item => item.value > 0 && Number.isFinite(item.value));
  const allocationTotal = allocations.reduce((sum, item) => sum + item.value, 0);
  const denominator = model.hero.totalValue > 0 ? model.hero.totalValue : allocationTotal;
  return <div className="space-y-3" data-testid="portfolio-overview">
    <div className={styles.portfolioTop}>
      <PortfolioValueCard source={source} value={model.hero.totalValue} {...facts} period={period} history={model.quality.historyReady ? model.history : []} action={action} />
      {briefing}
    </div>
    <div className={styles.portfolioInsights}>
      <SurfaceCard data-testid="portfolio-performance"><SurfaceCardContent className={styles.insightCard}>
        <SectionLabel role="heading" aria-level={2}>Performance</SectionLabel>
        {since ? <div>
          <p className={styles.insightEyebrow}>Since you bought</p>
          <p className={cn(styles.insightAmount, tone(since.gain))}>{signedMoney(since.gain)}{since.pct !== null ? ` · ${signedPercent(since.pct)}` : ""}</p>
          {since.covered < since.eligible ? <p className={styles.description}>Unrealized, on {since.covered} of {since.eligible} positions</p> : null}
        </div> : null}
        {model.quality.gainLossReady && distribution.total ? <>
          <div className={styles.performanceDistribution}>
            <div className={styles.performanceRing} role="img" aria-label={`${distribution.total} positions with reported gain or loss`}>
              <PieChart width={112} height={112}><Pie data={distribution.segments} dataKey="count" cx="50%" cy="50%" innerRadius={39} outerRadius={54} stroke="none" isAnimationActive={false}>
                {distribution.segments.map((segment, index) => <Cell key={segment.tone} fill={colors[index]} />)}
              </Pie></PieChart>
              <span>{distribution.total}<small>positions</small></span>
            </div>
            <dl className={styles.performanceLegend}>{distribution.segments.map((segment, index) => <div key={segment.tone}><dt><i style={{ background: colors[index] }} />{segment.label}</dt><dd>{segment.count}</dd></div>)}</dl>
          </div>
          <div className={styles.performanceMovers}>{[{ label: "Biggest gain", position: movers.gains[0] }, { label: "Biggest loss", position: movers.losses[0] }].map(({ label, position }) => position ? <div key={label}><p className={styles.description}>{label}</p><span><SymbolAvatar symbol={position.displaySymbol} name={position.name} size="md" className="size-7 rounded-lg" /><span className="truncate" title={position.name || position.displaySymbol}>{position.name || position.displaySymbol}</span></span></div> : null)}</div>
        </> : null}
        {performanceRows.length ? <dl className={styles.insightFacts}>
          {performanceRows.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
        </dl> : since ? null : <p className={styles.description}>No performance figures in this statement.</p>}
        <div className={styles.cardFooter}><ShellActionSurface variant="pill" className="min-h-11 ui-text-compact-button-label" onClick={() => onOpenSection("performance")}>View performance</ShellActionSurface></div>
      </SurfaceCardContent></SurfaceCard>
      <SurfaceCard><SurfaceCardContent className={styles.insightCard}>
        <div className="flex items-baseline justify-between gap-3"><SectionLabel role="heading" aria-level={2}>Allocation</SectionLabel><span className={styles.description}>% of portfolio</span></div>
        {allocations.length && denominator > 0 ? <>
          {allocationTotal <= denominator * 1.001 ? <div className={styles.portfolioAllocation} aria-hidden="true">{allocations.map(item => <span key={item.name} style={{ width: `${item.value / denominator * 100}%`, background: allocationColor(item.name) }} />)}</div> : null}
          <dl className={styles.portfolioList}>{allocations.map(item => <div className={styles.portfolioListRow} key={item.name}><dt className="flex items-center gap-2 text-sm"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: allocationColor(item.name) }} />{item.name}</dt><dd className="text-sm font-semibold tabular-nums">{(item.value / denominator * 100).toFixed(1)}%</dd></div>)}</dl>
        </> : <p className={styles.description}>Allocation is unavailable for this source.</p>}
        <div className={styles.cardFooter}><ShellActionSurface variant="pill" className="min-h-11 ui-text-compact-button-label" onClick={() => onOpenSection("allocation")}>View allocation</ShellActionSurface></div>
      </SurfaceCardContent></SurfaceCard>
    </div>
    <SurfaceCard><SurfaceCardContent className="space-y-2 p-4">
      <div className="flex items-center justify-between gap-3"><SectionLabel role="heading" aria-level={2}>Holdings</SectionLabel><ShellActionSurface variant="pill" className="min-h-11 ui-text-compact-button-label" onClick={() => onOpenSection("holdings")}>All {model.hero.holdingsCount}</ShellActionSurface></div>
      {positions.length ? <div className={styles.portfolioList}>{positions.slice(0, 3).map(position => <button type="button" aria-haspopup="dialog" aria-expanded={position.id === selectedHoldingId} data-finance-selected={position.id === selectedHoldingId || undefined} className={`${styles.portfolioListRow} ${styles.interactiveRow} relative isolate w-full overflow-hidden rounded-sm text-left`} key={position.id} onClick={() => setSelectedHoldingId(position.id)}>
        <span className="flex min-w-0 items-center gap-3"><SymbolAvatar symbol={position.displaySymbol} name={position.name} size="md" className="size-8 rounded-lg" /><span className="min-w-0"><span className="block truncate text-sm font-semibold" title={position.name || position.displaySymbol}>{position.name || position.displaySymbol}</span><span className={styles.description}>{position.displaySymbol}{position.sector ? ` · ${position.sector}` : ""}</span></span></span>
        <span className="text-right text-sm font-semibold tabular-nums">{formatCurrency(position.marketValue, position.currency)}{model.hero.totalValue > 0 ? <span className={`block ${styles.description}`}>{(position.marketValue / model.hero.totalValue * 100).toFixed(1)}% of portfolio</span> : null}</span>
        <MaterialRipple variant="none" effect="fade" disableHover className="z-10" />
      </button>)}</div> : <p className={styles.description}>No positions are available in this source.</p>}
    </SurfaceCardContent></SurfaceCard>
    <HoldingDetailsDrawer
      open={Boolean(selectedHolding)}
      holding={selectedHolding ? toHoldingViewModel({ ...selectedHolding, entries: selectedEntries }, totalValue, {
        source, valuationKind, statementAsOf: portfolio.account_info?.statement_period_end,
      }) : null}
      entries={selectedEntries?.map(entry => toHoldingViewModel(entry, totalValue))}
      canManageHoldings={false}
      loadHistory={loadHistory}
      onOpenChange={open => { if (!open) setSelectedHoldingId(null); }}
    />
    {sharing}
    <div className="flex items-center justify-between gap-3" aria-label="Portfolio actions">
      {onImport ? <ShellActionSurface variant="pill" className="min-h-11 ui-text-compact-button-label" data-voice-control-id="import_portfolio" onClick={onImport}>Import portfolio</ShellActionSurface> : <span />}
      <ShellActionSurface variant="pill" className="min-h-11 ui-text-compact-button-label" data-voice-control-id="manage_portfolio" onClick={() => onOpenSection("sources")}>Manage portfolio</ShellActionSurface>
    </div>
  </div>;
}
