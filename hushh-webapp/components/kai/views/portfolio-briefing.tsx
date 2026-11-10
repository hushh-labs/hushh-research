"use client";

import type { CSSProperties, ReactNode } from "react";
import { SectionLabel } from "@/components/app-ui/typography";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
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
export function PortfolioAnalysis({ model, loading = false }: { model?: DashboardViewModel; loading?: boolean }) {
  const [drop, setDrop] = useState(20);
  const total = model?.hero.totalValue ?? 0;
  const allocation = (model?.allocation ?? []).filter(({ value }) => Number.isFinite(value) && value > 0);
  const mappedTotal = allocation.reduce((sum, { value }) => sum + value, 0);
  const coverage = mappedTotal / total;
  const showMix = allocation.length > 0 && coverage >= 0.99 && coverage <= 1.01;
  const stocks = new Map<string, { name: string; value: number }>();
  const positions = model?.canonicalModel.positions ?? [];
  for (const position of positions) {
    if (!position.tickerSymbol || !Number.isFinite(position.marketValue) || position.marketValue <= 0 ||
        position.assetBucket !== "equity" || position.isCashEquivalent ||
        !/^(common stock|preferred stock|stocks?|equit(?:y|ies))$/i.test(position.assetType?.trim() ?? "")) continue;
    const key = position.tickerSymbol;
    stocks.set(key, { name: position.name || key, value: (stocks.get(key)?.value ?? 0) + position.marketValue });
  }
  const largest = [...stocks.values()].sort((a, b) => b.value - a.value)[0];
  const stockWeight = largest ? largest.value / total : 0;
  const stock = largest && stockWeight >= 0.15 && stockWeight <= 1 ? largest : undefined;
  const showHistory = !stock && model?.quality.historyReady === true;
  const cash = model?.canonicalModel.totals.cashValue ?? 0;
  const buckets = model?.canonicalModel.allocation ?? [];
  const bucketCoverage = buckets.reduce((sum, { value }) => sum + value, 0) / total;
  const investedBuckets = buckets.filter(({ key }) =>
    key === "equity" || key === "fixed_income" || key === "real_asset");
  const investedValue = investedBuckets.reduce((sum, { value }) => sum + value, 0);
  const investedWeight = investedValue / total;
  const hasCompleteBalances = bucketCoverage >= 0.99 && bucketCoverage <= 1.01
    && positions.every(({ marketValue }) => Number.isFinite(marketValue) && marketValue >= 0);
  const showScenario = Boolean(stock) || (!showHistory && hasCompleteBalances && investedWeight > 0 && investedWeight <= 1);
  const weight = stock ? stockWeight : investedWeight;
  const scenarioTitle = stock ? "What if your largest stock falls?" : "What if your investments fall?";
  const scenarioSubject = stock?.name ?? investedBuckets.map(({ label }) => label).join(", ");

  const mix = stock && cash >= 0 && cash + stock.value <= total
    ? [
        { name: "Cash", value: cash, color: "var(--review-cash)" },
        { name: "Largest stock", value: stock.value, color: "var(--review-stock)" },
        { name: "Other holdings", value: total - cash - stock.value, color: "var(--review-other)" },
      ].filter(({ value }) => value > 0)
    : allocation.map((row, index) => ({
        ...row,
        color: reviewMixColors[index % reviewMixColors.length]!,
      }));
  const mixTotal = mix.reduce((sum, { value }) => sum + value, 0);
  let sliceEnd = 0;
  const slices: string[] = [];
  for (const { value, color } of mix) {
    const start = sliceEnd;
    sliceEnd += value / mixTotal * 100;
    slices.push(`${color} ${start}% ${sliceEnd}%`);
  }
  const estimate = `−${(weight * drop).toFixed(1)}%`;

  return (
    <section className="grid gap-3 md:grid-cols-2" aria-label="Portfolio analysis" data-testid="portfolio-analysis">
      <SurfaceCard className={styles.reviewInsight}>
        <SurfaceCardContent className="flex h-full flex-col gap-3 p-4">
          <h3 className="ui-text-section-label">Portfolio mix</h3>
          {showMix ? (
            <div className="flex flex-1 flex-wrap items-center gap-5">
              <div aria-hidden className="grid size-[5.5rem] shrink-0 place-items-center rounded-full"
                style={{ background: `conic-gradient(${slices.join(", ")})` }}>
                <span className="size-[3.75rem] rounded-full bg-card" />
              </div>
              <dl className="min-w-32 flex-1 space-y-2">
                {mix.map(({ name, value, color }) => (
                  <div key={name} className="flex items-center justify-between gap-2">
                    <dt className="flex min-w-0 items-center gap-2 ui-text-row-description">
                      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: color }} />
                      <span className="truncate" title={name}>{name}</span>
                    </dt>
                    <dd className="shrink-0 ui-text-row-label-emphasized tabular-nums">{(value / mixTotal * 100).toFixed(1)}%</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <p className={styles.description}>{loading ? "Loading allocation…" : "A complete allocation is unavailable."}</p>
          )}
        </SurfaceCardContent>
      </SurfaceCard>
      {showScenario ? (
        <SurfaceCard className={styles.reviewInsight}>
          <SurfaceCardContent className="space-y-2 p-4">
            <div>
              <h3 className="ui-text-section-label">{scenarioTitle}</h3>
              <p className="ui-text-row-description truncate" title={scenarioSubject}>
                {scenarioSubject} · {(weight * 100).toFixed(1)}% of portfolio
              </p>
            </div>
            <div role="group" aria-label={stock ? "Hypothetical stock decline" : "Hypothetical investment decline"} className="flex flex-wrap gap-1.5">
              {[10, 20, 30].map((value) => (
                <ShellActionSurface key={value} variant="pill" className={styles.scenarioOption}
                  aria-pressed={drop === value} onClick={() => setDrop(value)}>
                  −{value}%
                </ShellActionSurface>
              ))}
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2" aria-live="polite">
              <span className="ui-text-row-description">Estimated portfolio change</span>
              <strong className="ui-text-row-label-emphasized tabular-nums">{estimate}</strong>
            </div>
            <div aria-hidden="true">
              <svg viewBox="0 0 300 38" preserveAspectRatio="none" className={styles.scenarioChart}>
                <path d="M2 2H298 M2 19H298 M2 36H298" className={styles.scenarioGrid} />
                <path d="M2 2L298 36H2Z" className={styles.scenarioFill} />
                <path d="M2 2L298 36" className={styles.scenarioLine} />
                <circle cx={2 + 296 * drop / 30} cy={2 + 34 * drop / 30} r="2" className={styles.scenarioPoint} />
              </svg>
              <div className={styles.scenarioAxis}><span>0% drop</span><span>30% drop</span></div>
            </div>
            <p className={styles.description}>{stock
              ? "Assumes all other holdings stay flat."
              : "Assumes these investments fall together and everything else stays flat."}</p>
          </SurfaceCardContent>
        </SurfaceCard>
      ) : showHistory && model ? (
        <SurfaceCard><SurfaceCardContent className="space-y-2.5 p-4">
          <h3 className="ui-text-section-label">Balance history</h3>
          <PortfolioHistoryChart data={model.history} height={180} />
          <p className={styles.description}>Balances include deposits and withdrawals.</p>
        </SurfaceCardContent></SurfaceCard>
      ) : (
        <SurfaceCard><SurfaceCardContent className="space-y-2.5 p-4">
          <h3 className="ui-text-section-label">Portfolio insights</h3>
          <p className={styles.description}>{loading ? "Loading portfolio insights…"
            : hasCompleteBalances && cash >= total && investedValue === 0 ? "This snapshot only shows cash."
            : "There isn’t enough saved information for a scenario or balance history."}</p>
        </SurfaceCardContent></SurfaceCard>
      )}
    </section>
  );
}

const reviewMixColors = [
  "var(--review-stock)",
  "var(--review-bond)",
  "var(--review-cash)",
  "var(--review-other)",
];
