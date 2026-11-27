"use client";

import type { ReactNode } from "react";
import { ArrowRight, Briefcase, PieChart, Settings2, Upload } from "@/components/icons";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { PortfolioValueCard } from "@/components/kai/cards/portfolio-value-card";
import { allocationColor } from "@/lib/kai/allocation-colors";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/kai/market-value-format";
import { useMarketCurrency } from "@/lib/kai/use-market-currency";
import { useMediaQuery } from "@/lib/morphy-ux/use-media-query";
import type { KaiPortfolioSection } from "@/lib/navigation/routes";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import type { DashboardViewModel } from "./dashboard-data-mapper";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import { overviewFacts, type PortfolioImportLabel } from "./portfolio-display-facts";

/** The web and native overview use the same displayed position and allocation facts. */
export function portfolioOverviewLayout(model: DashboardViewModel) {
  const positions = model.canonicalModel.positions
    .filter(position => !position.isCashEquivalent && position.marketValue > 0)
    .sort((a, b) => b.marketValue - a.marketValue);
  const allocations = model.allocation.filter(item => item.value > 0 && Number.isFinite(item.value));
  const allocationTotal = allocations.reduce((sum, item) => sum + item.value, 0);
  const denominator = model.hero.totalValue > 0 ? model.hero.totalValue : allocationTotal;
  return { positions, allocations, allocationTotal, denominator };
}

export function PortfolioOverview({ model, portfolio, source, importLabel, period, action, briefing, sharing, onImport, onOpenSection }: {
  model: DashboardViewModel;
  portfolio: PortfolioData;
  source: string;
  importLabel?: PortfolioImportLabel;
  period: ReactNode;
  action?: ReactNode;
  briefing?: ReactNode;
  sharing?: ReactNode;
  onImport?: () => void;
  onOpenSection: (section: KaiPortfolioSection) => void;
}) {
  useMarketCurrency();
  const desktop = useMediaQuery("(min-width: 900px)");
  const { invested, cash, change, changePct } = overviewFacts(model, portfolio);
  return (
    <div className={styles.portfolioHome} data-testid="portfolio-overview">
      <section className={styles.portfolioLead} aria-label="Portfolio summary">
        <PortfolioValueCard
          source={source}
          importLabel={importLabel}
          value={model.hero.totalValue}
          invested={invested}
          cash={cash}
          change={change}
          changePct={changePct}
          period={period}
          action={action}
          onOpenPerformance={() => onOpenSection("performance")}
        />
        <div className={styles.portfolioLeadRight}>
          {briefing}
          {desktop ? sharing : null}
        </div>
      </section>
      <SettingsGroup
        embedded
        shellClassName={styles.portfolioExploreShell}
        contentClassName={styles.portfolioExploreRows}
        density="compact"
        testId="portfolio-explore"
      >
        <SettingsRow
          title="Portfolio mix"
          className={styles.portfolioExploreMix}
          icon={PieChart}
          iconTone="blue"
          description={<PortfolioMixPreview model={model} />}
          describeContent
          onClick={() => onOpenSection("allocation")}
          ariaLabel="View allocation"
          voiceControlId="show_portfolio_allocation"
          trailing={<span className={styles.portfolioExploreLink}>View mix <ArrowRight size={14} aria-hidden="true" /></span>}
          chevron
        />
        <SettingsRow
          title="Holdings"
          className={styles.portfolioExploreHoldings}
          icon={Briefcase}
          iconTone="green"
          description={<PortfolioHoldingsPreview model={model} />}
          describeContent
          onClick={() => onOpenSection("holdings")}
          ariaLabel="View holdings"
          voiceControlId="show_portfolio_holdings"
          trailing={<span className={styles.portfolioExploreLink}>View holdings <ArrowRight size={14} aria-hidden="true" /></span>}
          chevron
        />
      </SettingsGroup>
      {desktop ? null : sharing}
      <div className={styles.portfolioHomeActions} role="group" aria-label="Portfolio actions">
        {onImport ? (
          <ShellActionSurface variant="pill" className={styles.portfolioHomeAction} data-voice-control-id="import_portfolio" onClick={onImport}>
            <Upload size={15} aria-hidden="true" /> Import portfolio
          </ShellActionSurface>
        ) : null}
        <ShellActionSurface variant="pill" className={styles.portfolioHomeAction} data-voice-control-id="manage_portfolio" onClick={() => onOpenSection("sources")}>
          <Settings2 size={15} aria-hidden="true" /> Manage portfolio
        </ShellActionSurface>
      </div>
    </div>
  );
}

function PortfolioMixPreview({ model }: { model: DashboardViewModel }) {
  const allocations = model.allocation
    .filter(({ value }) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b.value - a.value);
  const total = model.hero.totalValue;
  const allocated = allocations.reduce((sum, { value }) => sum + value, 0);
  const showWeights = Number.isFinite(total) && total > 0 && allocated <= total * 1.001;
  return (
    <span className={styles.portfolioExploreDetail}>
      {allocations.length === 0 ? "Allocation unavailable" : (
        <>
          {showWeights ? (
            <span className={styles.portfolioMixStrip} aria-hidden="true">
              {allocations.map(({ name, value }, index) => (
                <span key={index} style={{ width: `${value / total * 100}%`, color: allocationColor(name) }} />
              ))}
            </span>
          ) : null}
          <span className={styles.portfolioMixFacts}>
            {allocations.slice(0, 3).map(({ name, value }, index) => (
              <span key={index} className={cn(styles.portfolioExploreFact, index > 0 && styles.portfolioWideOnly)}>
                <span className={styles.portfolioMixCategory}>
                  <span className={styles.allocationDot} style={{ backgroundColor: allocationColor(name) }} aria-hidden="true" />
                  {name}
                </span>
                <strong>{showWeights ? `${(value / total * 100).toFixed(1)}%` : formatCurrency(value)}</strong>
              </span>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

function PortfolioHoldingsPreview({ model }: { model: DashboardViewModel }) {
  const { positions } = portfolioOverviewLayout(model);
  const count = model.canonicalModel.positions.length;
  return (
    <span className={styles.portfolioExploreDetail}>
      <span>{count} saved {count === 1 ? "holding" : "holdings"}</span>
      {positions.slice(0, 2).map(({ id, tickerSymbol, name, marketValue }) => (
        <span key={id} className={cn(styles.portfolioExploreFact, styles.portfolioWideOnly)}>
          <span title={name}>{tickerSymbol || name}</span>
          <strong>{formatCurrency(marketValue)}</strong>
        </span>
      ))}
    </span>
  );
}
