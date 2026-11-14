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
import { sinceBought, winnersLosers } from "@/lib/kai/portfolio-performance";

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
  const colors = ["var(--finance-negative)", "color-mix(in srgb, var(--finance-negative) 50%, transparent)", "var(--chart-4)", "color-mix(in srgb, var(--finance-positive) 50%, transparent)", "var(--finance-positive)"];
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
      <SurfaceCard data-testid="portfolio-performance"><SurfaceCardContent className={styles.compactInsight}>
        <SectionLabel role="heading" aria-level={2}>Performance</SectionLabel>
        <div className={styles.performanceSummary}>
        {since ? <div className="min-w-0">
          <p className={styles.insightEyebrow}>Since you bought</p>
          <p className={cn(styles.insightAmount, tone(since.gain))}>{signedMoney(since.gain)}{since.pct !== null ? ` · ${signedPercent(since.pct)}` : ""}</p>
          {since.covered < since.eligible ? <p className={styles.description}>Unrealized, on {since.covered} of {since.eligible} positions</p> : null}
        </div> : facts.change !== null ? <div className="min-w-0"><p className={styles.insightEyebrow}>Reported balance change</p><p className={styles.insightAmount}>{formatCurrency(facts.change)}</p></div> : null}
        {model.quality.gainLossReady && distribution.total ? (
            <div className={styles.performanceRing} role="img" aria-label={`${distribution.total} positions with reported gain or loss. ${distribution.segments.map(segment => `${segment.label}: ${segment.count}`).join(". ")}`}>
              <PieChart width={80} height={80}><Pie data={distribution.segments} dataKey="count" cx="50%" cy="50%" innerRadius={27} outerRadius={39} stroke="none" isAnimationActive={false}>
                {distribution.segments.map((segment, index) => <Cell key={segment.tone} fill={colors[index]} />)}
              </Pie></PieChart>
              <span>{distribution.total}<small>positions</small></span>
            </div>
        ) : null}
        </div>
        {!since ? <p className={styles.description}>{facts.change === null ? "No performance figures in this statement." : "Balance changes may include cash flows."}</p> : null}
        <div className={styles.cardFooter}><ShellActionSurface variant="pill" className="min-h-11 ui-text-compact-button-label" onClick={() => onOpenSection("performance")}>View performance</ShellActionSurface></div>
      </SurfaceCardContent></SurfaceCard>
      <SurfaceCard><SurfaceCardContent className={styles.compactInsight}>
        <div className="flex items-baseline justify-between gap-3"><SectionLabel role="heading" aria-level={2}>Allocation</SectionLabel><span className={styles.description}>% of portfolio</span></div>
        {allocations.length && denominator > 0 ? <>
          {allocationTotal <= denominator * 1.001 ? <div className={styles.portfolioAllocation} aria-hidden="true">{allocations.map(item => <span key={item.name} style={{ width: `${item.value / denominator * 100}%`, background: allocationColor(item.name) }} />)}</div> : null}
          <dl className={styles.allocationSummary}>{allocations.map(item => <div key={item.name}><dt><span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: allocationColor(item.name) }} />{item.name}</dt><dd>{(item.value / denominator * 100).toFixed(1)}%</dd></div>)}</dl>
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
