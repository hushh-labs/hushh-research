"use client";

import type { CSSProperties, ReactNode } from "react";
import { SectionLabel } from "@/components/app-ui/typography";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { formatCurrency } from "@/lib/kai/market-value-format";
import type { LinkedNetWorthScore } from "@/lib/kai/plaid-vault/types";
import { topPortfolioWeights } from "./portfolio-analysis-facts";
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

/** Observed portfolio figures only. Balance history is never shown as returns. */
export function PortfolioAnalysis({ model, advisorCard }: {
  model: DashboardViewModel;
  advisorCard?: ReactNode;
}) {
  const weights = topPortfolioWeights(model);
  return (
    <section className="space-y-3" aria-label="Portfolio analysis" data-testid="portfolio-analysis">
      <div className={advisorCard ? "grid gap-3 md:grid-cols-2" : undefined}>
        {advisorCard}
        <SurfaceCard><SurfaceCardContent className="space-y-2.5 p-4">
          <h2 className="ui-text-section-label">Largest holdings</h2>
          {weights.length ? (
            <dl className="space-y-3">
              {weights.map(({ name, percent }, index) => (
                <div key={index} className="space-y-1">
                  <div className="flex justify-between gap-3 ui-text-row-label">
                    <dt className="min-w-0 truncate" title={name}>{name}</dt>
                    <dd className="shrink-0 tabular-nums">{percent.toFixed(1)}%</dd>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <div className="h-full rounded-full bg-[var(--app-accent)]" style={{ width: `${percent}%` }} />
                  </div>
                </div>
              ))}
            </dl>
          ) : <p className={styles.description}>Position weights are unavailable for this source.</p>}
        </SurfaceCardContent></SurfaceCard>
      </div>
      {model.quality.historyReady ? (
        <SurfaceCard><SurfaceCardContent className="space-y-2.5 p-4">
          <h2 className="ui-text-section-label">Balance history</h2>
          <PortfolioHistoryChart data={model.history} height={180} />
          <p className={styles.description}>Balances include deposits and withdrawals.</p>
        </SurfaceCardContent></SurfaceCard>
      ) : null}
    </section>
  );
}
