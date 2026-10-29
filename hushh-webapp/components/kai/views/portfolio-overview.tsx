"use client";

import type { ReactNode } from "react";
import { BarChart3, CalendarDays } from "@/components/icons";
import { SectionLabel } from "@/components/app-ui/typography";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { PortfolioValueCard } from "@/components/kai/cards/portfolio-value-card";
import { allocationColor } from "@/lib/kai/allocation-colors";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import type { DashboardViewModel } from "./dashboard-data-mapper";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import type { KaiPortfolioSection } from "@/lib/navigation/routes";
import { overviewFacts } from "./portfolio-display-facts";

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

export function PortfolioOverview({ model, portfolio, source, period, action, briefing, sharing, onImport, onOpenSection }: {
  model: DashboardViewModel; portfolio?: PortfolioData | null; source: string;
  period: string; action?: ReactNode; briefing?: ReactNode; sharing?: ReactNode; onImport?: () => void; onOpenSection: (section: KaiPortfolioSection) => void;
}) {
  const facts = overviewFacts(model, portfolio);
  const positions = [...model.canonicalModel.positions].filter(position => !position.isCashEquivalent && position.marketValue > 0).sort((a, b) => b.marketValue - a.marketValue);
  const allocations = model.allocation.filter(item => item.value > 0 && Number.isFinite(item.value));
  const allocationTotal = allocations.reduce((sum, item) => sum + item.value, 0);
  const denominator = model.hero.totalValue > 0 ? model.hero.totalValue : allocationTotal;
  return <div className="space-y-4" data-testid="portfolio-overview">
    <div className={styles.portfolioTop}>
      <PortfolioValueCard source={source} value={model.hero.totalValue} {...facts} period={period} history={model.quality.historyReady ? model.history : []} action={action} />
      {briefing}
    </div>
    <div className={styles.portfolioInsights}>
      <SurfaceCard className={styles.insightShell} data-testid="portfolio-performance"><SurfaceCardContent className={`${styles.insightCard} space-y-0`}>
        <SectionLabel role="heading" aria-level={2}>Performance</SectionLabel>
        <div className={styles.balanceChange}><p className={styles.insightEyebrow}>Reported balance change</p><p className={facts.change === null ? styles.unavailableChange : styles.insightAmount}>{facts.change === null ? "Unavailable" : money(facts.change)}</p></div>
        <dl className={styles.insightFacts}>
          <div><dt><CalendarDays aria-hidden="true" />Dated history</dt><dd>{model.quality.historyReady ? "Available" : "Not provided"}</dd></div>
          <div><dt><BarChart3 aria-hidden="true" />Investment return</dt><dd>Unavailable</dd></div>
        </dl>
        <p className={styles.description}>Balance changes can include cash flows.<br />They aren’t investment returns.</p>
        <div className={styles.cardFooter}><ShellActionSurface variant="pill" className="min-h-11" onClick={() => onOpenSection("performance")}>View performance</ShellActionSurface></div>
      </SurfaceCardContent></SurfaceCard>
      <SurfaceCard className={styles.insightShell}><SurfaceCardContent className={styles.insightCard}>
        <div className="flex items-baseline justify-between gap-3"><SectionLabel role="heading" aria-level={2}>Allocation</SectionLabel><span className={styles.description}>% of portfolio</span></div>
        {allocations.length && denominator > 0 ? <>
          {allocationTotal <= denominator * 1.001 ? <div className={styles.portfolioAllocation} aria-hidden="true">{allocations.map(item => <span key={item.name} style={{ width: `${item.value / denominator * 100}%`, background: allocationColor(item.name) }} />)}</div> : null}
          <dl className={styles.portfolioList}>{allocations.map(item => <div className={styles.portfolioListRow} key={item.name}><dt className="flex items-center gap-2 text-sm"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: allocationColor(item.name) }} />{item.name}</dt><dd className="text-sm font-semibold tabular-nums">{(item.value / denominator * 100).toFixed(1)}%</dd></div>)}</dl>
        </> : <p className={styles.description}>Allocation is unavailable for this source.</p>}
        <div className={styles.cardFooter}><ShellActionSurface variant="pill" className="min-h-11" onClick={() => onOpenSection("allocation")}>View allocation</ShellActionSurface></div>
      </SurfaceCardContent></SurfaceCard>
    </div>
    <SurfaceCard><SurfaceCardContent className="space-y-2 p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3"><SectionLabel role="heading" aria-level={2}>Holdings</SectionLabel><ShellActionSurface variant="pill" className="min-h-11" onClick={() => onOpenSection("holdings")}>All {model.hero.holdingsCount}</ShellActionSurface></div>
      {positions.length ? <div className={styles.portfolioList}>{positions.slice(0, 3).map(position => <button type="button" className={`${styles.portfolioListRow} relative isolate w-full overflow-hidden rounded-sm text-left`} key={position.id} onClick={() => onOpenSection("holdings")}>
        <span className="flex min-w-0 items-center gap-3"><span aria-hidden="true" className={styles.portfolioHoldingMark}>{(position.displaySymbol || position.name).slice(0, 2).toUpperCase()}</span><span className="min-w-0"><span className="block truncate text-sm font-semibold">{position.name || position.displaySymbol}</span><span className={styles.description}>{position.displaySymbol}{position.sector ? ` · ${position.sector}` : ""}</span></span></span>
        <span className="text-right text-sm font-semibold tabular-nums">{money(position.marketValue)}{model.hero.totalValue > 0 ? <span className={`block ${styles.description}`}>{(position.marketValue / model.hero.totalValue * 100).toFixed(1)}% of portfolio</span> : null}</span>
        <MaterialRipple variant="none" effect="fade" className="z-10" />
      </button>)}</div> : <p className={styles.description}>No positions are available in this source.</p>}
    </SurfaceCardContent></SurfaceCard>
    {sharing}
    <div className="flex items-center justify-between gap-3" aria-label="Portfolio actions">
      {onImport ? <ShellActionSurface variant="pill" className="min-h-11" data-voice-control-id="import_portfolio" onClick={onImport}>Import portfolio</ShellActionSurface> : <span />}
      <ShellActionSurface variant="pill" className="min-h-11" data-voice-control-id="manage_portfolio" onClick={() => onOpenSection("sources")}>Manage portfolio</ShellActionSurface>
    </div>
  </div>;
}
