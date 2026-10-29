"use client";

import type { ReactNode } from "react";
import { SectionLabel } from "@/components/app-ui/typography";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { PortfolioHistoryChart } from "@/components/kai/charts/portfolio-history-chart";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import type { DashboardViewModel } from "./dashboard-data-mapper";

const money = (value: number) => new Intl.NumberFormat(undefined, {
  style: "currency", currency: "USD", maximumFractionDigits: 2,
}).format(value);

function largestPosition(model?: DashboardViewModel) {
  if (!model || model.hero.totalValue <= 0) return null;
  const position = model.canonicalModel.positions.reduce<typeof model.canonicalModel.positions[number] | null>(
    (largest, current) => current.marketValue > 0 && (!largest || current.marketValue > largest.marketValue) ? current : largest, null,
  );
  return position ? { name: position.name || position.displaySymbol, weightPct: position.marketValue / model.hero.totalValue * 100 } : null;
}

/** A summary of the active saved portfolio, without assuming a market update or recommendation. */
export function PortfolioBriefing({ model, onOpen, advisorAction }: { model?: DashboardViewModel; onOpen?: () => void; advisorAction?: ReactNode }) {
  const largest = largestPosition(model);
  const leadingSector = model?.quality.sectorReady ? model.equity_sector_allocation[0] : undefined;
  return <SurfaceCard className={styles.insightShell} data-testid="portfolio-briefing">
    <SurfaceCardContent className={styles.insightCard}>
      <SectionLabel role="heading" aria-level={2}>One’s briefing</SectionLabel>
      <ul className="space-y-3 text-sm leading-6 text-muted-foreground">
        <li>{!model ? "Add a portfolio to see your analysis." : largest
          ? `${largest.name} is your largest tracked position at ${largest.weightPct.toFixed(1)}% of your portfolio.`
          : "Your saved portfolio is ready to review. Position concentration is unavailable for this source."}</li>
        {model ? <li>{model.quality.historyReady ? "Dated portfolio balances are available to review." : "Dated balance history is unavailable for this source."}</li> : null}
        {leadingSector ? <li>{`${leadingSector.sector} represents ${leadingSector.pct.toFixed(1)}% of your portfolio.`}</li> : null}
      </ul>
      <div className={styles.cardFooter}>{onOpen ? <ShellActionSurface variant="pill" className="min-h-11" onClick={onOpen}>
        {model ? "View analysis" : "Import portfolio"}
      </ShellActionSurface> : null}{advisorAction}</div>
    </SurfaceCardContent>
  </SurfaceCard>;
}

/** These figures are derived from the active portfolio; absent history stays absent. */
export function PortfolioAnalysis({ model, source }: { model: DashboardViewModel; source: string }) {
  const largest = largestPosition(model);
  return <div className="space-y-4" data-testid="portfolio-analysis">
    <SurfaceCard><SurfaceCardContent className="space-y-3 p-5">
      <h2 className="ui-text-section-label">Portfolio overview</h2>
      <p className="text-sm text-muted-foreground">Based on {source.toLowerCase()} information{model.hero.statementPeriod ? ` · ${model.hero.statementPeriod}` : " · current saved snapshot"}.</p>
      <dl className={styles.summaryFacts}>
        <div><dt>Portfolio value</dt><dd>{money(model.hero.totalValue)}</dd></div>
        <div><dt>Positions</dt><dd>{model.hero.holdingsCount}</dd></div>
        <div><dt>Largest tracked position</dt><dd>{largest ? `${largest.name} · ${largest.weightPct.toFixed(1)}%` : "Unavailable"}</dd></div>
        <div><dt>Value history</dt><dd>{model.quality.historyReady ? `${model.history.length} saved observations` : "Unavailable"}</dd></div>
      </dl>
    </SurfaceCardContent></SurfaceCard>
    <SurfaceCard><SurfaceCardContent className="space-y-3 p-5">
      <h2 className="ui-text-section-label">Value history</h2>
      {model.quality.historyReady ? <>
        <PortfolioHistoryChart data={model.history} height={180} />
        <p className={styles.description}>Saved balance changes may include deposits and withdrawals; they are not investment returns.</p>
      </> : <p className={styles.description}>Dated balance history is unavailable for this source.</p>}
    </SurfaceCardContent></SurfaceCard>
    <SurfaceCard><SurfaceCardContent className="space-y-3 p-5">
      <h2 className="ui-text-section-label">Position concentration</h2>
      {model.canonicalModel.positions.length && model.hero.totalValue > 0 ? <>
        <p className={styles.description}>The largest available positions as a share of the selected portfolio's value.</p>
        <dl className={styles.facts}>{[...model.canonicalModel.positions].sort((a, b) => b.marketValue - a.marketValue).slice(0, 5).map(position =>
          <div className={styles.fact} key={position.id}><dt>{position.name || position.displaySymbol}</dt><dd>{money(position.marketValue)} · {(position.marketValue / model.hero.totalValue * 100).toFixed(1)}%</dd></div>)}</dl>
      </> : <p className={styles.description}>Position concentration is unavailable for this source.</p>}
    </SurfaceCardContent></SurfaceCard>
    <SurfaceCard><SurfaceCardContent className="space-y-3 p-5">
      <h2 className="ui-text-section-label">Allocation</h2>
      {model.quality.allocationReady && model.allocation.length ? <dl className={styles.facts}>
        {model.allocation.map(row => <div className={styles.fact} key={row.name}><dt>{row.name}</dt><dd>{money(row.value)}{model.hero.totalValue > 0 ? ` · ${(row.value / model.hero.totalValue * 100).toFixed(1)}%` : ""}</dd></div>)}
      </dl> : <p className={styles.description}>Allocation is unavailable for this source.</p>}
      {model.quality.sectorReady && model.equity_sector_allocation.length ? <div className="space-y-2">
        <h3 className="text-sm font-semibold">Equity sectors</h3>
        <p className={styles.description}>Sector labels cover {(model.allocation_quality.equityCoveragePct * 100).toFixed(0)}% of eligible equity holdings.</p>
        <dl className={styles.facts}>{model.equity_sector_allocation.slice(0, 5).map(row => <div className={styles.fact} key={row.sector}><dt>{row.sector}</dt><dd>{row.pct.toFixed(1)}% of portfolio</dd></div>)}</dl>
      </div> : <p className={styles.description}>Equity sector information is unavailable or incomplete.</p>}
      <p className={styles.description}>Figures reflect the available saved source and may not include other accounts or recent market changes. This is not a recommendation.</p>
    </SurfaceCardContent></SurfaceCard>
  </div>;
}

