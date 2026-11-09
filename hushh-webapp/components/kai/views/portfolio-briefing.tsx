"use client";

import type { CSSProperties, ReactNode } from "react";
import { SectionLabel } from "@/components/app-ui/typography";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { allocationColor } from "@/lib/kai/allocation-colors";
import { formatCurrency } from "@/lib/kai/market-value-format";
import type { LinkedNetWorthScore } from "@/lib/kai/plaid-vault/types";
import { useState } from "react";
import { PortfolioHistoryChart } from "@/components/kai/charts/portfolio-history-chart";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import type { DashboardViewModel } from "./dashboard-data-mapper";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import { overviewFacts } from "./portfolio-display-facts";

/** The linked net worth score and the active portfolio’s cash share. */
export function PortfolioBriefing({
  model,
  portfolio,
  linkedNetWorthScore,
  onOpen,
  advisorAction,
}: {
  model?: DashboardViewModel;
  portfolio?: PortfolioData | null;
  linkedNetWorthScore?: LinkedNetWorthScore | null;
  onOpen?: () => void;
  advisorAction?: ReactNode;
}) {
  const score = linkedNetWorthScore?.score ?? null;
  const cash = model ? overviewFacts(model, portfolio).cash : null;
  const cashShare = cash !== null && model && model.hero.totalValue > 0
    ? `${(cash / model.hero.totalValue * 100).toFixed(1)}%`
    : "Unavailable";

  return <SurfaceCard className={model ? undefined : styles.importEntry} data-testid="portfolio-briefing">
    <SurfaceCardContent className={styles.insightCard}>
      <SectionLabel role="heading" aria-level={2}>Agent One’s briefing</SectionLabel>
      {model ? (
        <div className={styles.scoreSummary}>
          <div
            className={styles.scoreRing}
            style={{ "--nws-progress": `${(score ?? 0) / 10}%` } as CSSProperties}
            role={score === null ? "img" : "meter"}
            aria-label={score === null ? "Net Worth Score unavailable" : "Net Worth Score"}
            aria-valuemin={score === null ? undefined : 0}
            aria-valuemax={score === null ? undefined : 1000}
            aria-valuenow={score ?? undefined}
          >
            <span aria-hidden="true">{score ?? "—"}</span>
          </div>
          <div>
            <p className="ui-text-section-label">NWS score</p>
            <dl className={styles.scoreCashShare}>
              <dt>Cash share</dt>
              <dd>{cashShare}</dd>
            </dl>
          </div>
        </div>
      ) : <p className={styles.description}>Add a portfolio to see your analysis.</p>}
      <div className={`${styles.cardFooter} items-center`}>
        {model ? (
          <p className={`${styles.description} me-auto`}>Tracked holdings · {model.hero.holdingsCount}</p>
        ) : null}
        {onOpen ? (
          <ShellActionSurface variant="pill" className="min-h-11 ui-text-compact-button-label" onClick={onOpen}>
            {model ? "View analysis" : "Import portfolio"}
          </ShellActionSurface>
        ) : null}
        {advisorAction}
      </div>
    </SurfaceCardContent>
  </SurfaceCard>;
}

function netWorthScoreLabel(score: number | null) {
  return score === null ? "Unavailable" : `${score} / 1,000`;
}

export type NetWorthRecovery = {
  description: string;
  action?: { label: string; run: () => void; disabled?: boolean };
};

export function PortfolioNetWorthCard({
  result,
  recovery,
}: {
  result?: LinkedNetWorthScore | null;
  recovery?: NetWorthRecovery;
}) {
  const score = result?.score ?? null;
  const linkedNetWorth = result?.linked_net_worth_usd ?? null;
  const refreshTime = Date.parse(result?.balances_refreshed_at ?? "");
  const refreshDate = Number.isFinite(refreshTime)
    ? new Date(refreshTime).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;
  return (
    <SurfaceCard data-testid="portfolio-net-worth-score">
      <SurfaceCardContent className="space-y-2.5 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="ui-text-section-label">Net Worth Score</h2>
          <p className="shrink-0 ui-text-row-label-emphasized tabular-nums">
            {netWorthScoreLabel(score)}
          </p>
        </div>
        {score !== null ? (
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className="h-full rounded-full bg-[var(--app-accent)]" style={{ width: `${score / 10}%` }} />
          </div>
        ) : null}
        {linkedNetWorth !== null ? (
          <p className={styles.description}>
            {formatCurrency(linkedNetWorth)} across linked Plaid accounts
            {refreshDate ? <> · As of <time dateTime={result?.balances_refreshed_at}>{refreshDate}</time></> : null}
          </p>
        ) : null}
        {score === null ? (
          <>
            <p className={styles.description}>
              {recovery?.description ?? "A score requires current Plaid balances and a U.S. country on file."}
            </p>
            {recovery?.action ? (
              <ShellActionSurface variant="pill" className="min-h-11 ui-text-compact-button-label" disabled={recovery.action.disabled}
                onClick={recovery.action.run}>
                {recovery.action.label}
              </ShellActionSurface>
            ) : null}
          </>
        ) : null}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

/** Charts use saved holdings and balance history, never model estimates. */
export function PortfolioAnalysis({ model }: { model: DashboardViewModel }) {
  const [drop, setDrop] = useState(20);
  const total = model.hero.totalValue;
  const mix = model.allocation.filter(({ value }) => Number.isFinite(value) && value > 0);
  const mappedTotal = mix.reduce((sum, { value }) => sum + value, 0);
  const coverage = mappedTotal / total;
  const showMix = mix.length > 0 && coverage >= 0.99 && coverage <= 1.01;
  let sliceEnd = 0;
  const slices = showMix ? mix.map(({ name, value }) => {
    const start = sliceEnd;
    sliceEnd += value / mappedTotal * 100;
    return `${allocationColor(name)} ${start}% ${sliceEnd}%`;
  }) : [];
  const stocks = new Map<string, { name: string; value: number }>();
  for (const position of model.canonicalModel.positions) {
    if (!position.tickerSymbol || !Number.isFinite(position.marketValue) || position.marketValue <= 0 ||
        !/^(common stock|preferred stock|stock)$/i.test(position.assetType?.trim() ?? "")) continue;
    const key = position.tickerSymbol;
    stocks.set(key, { name: position.name || key, value: (stocks.get(key)?.value ?? 0) + position.marketValue });
  }
  const largest = [...stocks.values()].sort((a, b) => b.value - a.value)[0];
  const weight = largest ? largest.value / total : 0;
  const showScenario = largest && weight >= 0.15 && weight <= 1;
  if (!showMix && !showScenario && !model.quality.historyReady) return null;

  return (
    <section className="grid gap-3 md:grid-cols-2" aria-label="Portfolio analysis" data-testid="portfolio-analysis">
      {showMix ? (
        <SurfaceCard><SurfaceCardContent className="space-y-3 p-4">
          <h3 className="ui-text-section-label">Portfolio mix</h3>
          <div className="flex flex-wrap items-center gap-4">
            <div aria-hidden className="grid size-20 shrink-0 place-items-center rounded-full"
              style={{ background: `conic-gradient(${slices.join(", ")})` }}>
              <span className="size-12 rounded-full bg-card" />
            </div>
            <dl className="min-w-32 flex-1 space-y-1">
              {mix.map(({ name, value }) => (
                <div key={name} className="flex items-center justify-between gap-2 ui-text-row-label">
                  <dt className="flex min-w-0 items-center gap-1.5">
                    <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: allocationColor(name) }} />
                    <span className="truncate" title={name}>{name}</span>
                  </dt>
                  <dd className="shrink-0 tabular-nums">{(value / mappedTotal * 100).toFixed(1)}%</dd>
                </div>
              ))}
            </dl>
          </div>
        </SurfaceCardContent></SurfaceCard>
      ) : null}
      {showScenario ? (
        <SurfaceCard><SurfaceCardContent className="space-y-3 p-4">
          <h3 className="ui-text-section-label">What if your largest stock falls?</h3>
          <p className="ui-text-row-description truncate" title={largest.name}>
            {largest.name} · {(weight * 100).toFixed(1)}% of portfolio
          </p>
          <div role="group" aria-label="Hypothetical stock decline" className="flex flex-wrap gap-1.5">
            {[10, 20, 30].map((value) => <ShellActionSurface key={value} variant="pill" aria-pressed={drop === value} onClick={() => setDrop(value)}>
              −{value}%
            </ShellActionSurface>)}
          </div>
          <p aria-live="polite" className="ui-text-row-label">Portfolio change <strong>−{(weight * drop).toFixed(1)}%</strong></p>
          <p className={styles.description}>Assumes all other holdings stay flat.</p>
        </SurfaceCardContent></SurfaceCard>
      ) : model.quality.historyReady ? (
        <SurfaceCard><SurfaceCardContent className="space-y-2.5 p-4">
          <h3 className="ui-text-section-label">Balance history</h3>
          <PortfolioHistoryChart data={model.history} height={180} />
          <p className={styles.description}>Balances include deposits and withdrawals.</p>
        </SurfaceCardContent></SurfaceCard>
      ) : null}
    </section>
  );
}
