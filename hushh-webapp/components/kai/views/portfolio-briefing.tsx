"use client";

import { useEffect, useMemo, useState } from "react";
import { Lightbulb } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { PortfolioDeclineChart } from "@/components/kai/charts/portfolio-decline-chart";
import { PortfolioHistoryChart } from "@/components/kai/charts/portfolio-history-chart";
import type { PortfolioData } from "@/components/kai/types/portfolio";
import { FinancePersonaBadge } from "@/components/kai/onboarding/finance-persona-form";
import type { PersonaPreferences } from "@/lib/kai/investing-persona";
import { PortfolioReviewCarousel } from "./portfolio-review-carousel";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import type { FinanceSource } from "@/lib/finance-sharing/contract";
import { readSavedPortfolioReview, type PortfolioReviewResponse } from "@/lib/finance-sharing/portfolio-review-cache";
import { readPortfolioReviewInput } from "@/lib/finance-sharing/portfolio-review-input";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { portfolioDownsideFacts } from "./portfolio-analysis-facts";
import type { DashboardViewModel } from "./dashboard-data-mapper";
import { overviewFacts } from "./portfolio-display-facts";

function largestPosition(model?: DashboardViewModel) {
  if (!model || model.hero.totalValue <= 0) return null;
  const position = model.canonicalModel.positions.reduce<typeof model.canonicalModel.positions[number] | null>(
    (largest, current) => current.marketValue > 0 && (!largest || current.marketValue > largest.marketValue) ? current : largest, null,
  );
  return position ? { name: position.name || position.displaySymbol, symbol: position.displaySymbol, weightPct: position.marketValue / model.hero.totalValue * 100 } : null;
}

export function portfolioBriefingFacts(model?: DashboardViewModel, portfolio?: PortfolioData | null) {
  const largest = largestPosition(model);
  const leadingSector = model?.quality.sectorReady ? model.equity_sector_allocation[0] : undefined;
  const cash = model ? overviewFacts(model, portfolio).cash : null;
  const cashShare = cash !== null && model && model.hero.totalValue > 0 ? cash / model.hero.totalValue * 100 : null;
  const ringReady = largest && Number.isFinite(largest.weightPct) && largest.weightPct <= 100;
  return { largest, leadingSector, cashShare, ringReady };
}

export function PortfolioBriefing({ review, preferences, model, netDeposits, onOpen, missing }: {
  review?: Pick<PortfolioReviewResponse, "takeaway">;
  preferences?: PersonaPreferences;
  model?: DashboardViewModel;
  netDeposits?: number | null;
  onOpen: () => void;
  missing?: string;
}) {
  const takeaway = typeof review?.takeaway === "string" ? review.takeaway.trim() : undefined;
  return (
    <SurfaceCard data-testid="portfolio-briefing" className={styles.portfolioBriefingCard}>
      <section className={styles.portfolioBriefingContent} aria-label="Portfolio review">
        <header className={styles.portfolioBriefingHeader}>
          <span className={styles.portfolioBriefingHeading}>
            <span className={styles.portfolioBriefingIcon} aria-hidden="true">
              <Lightbulb size={18} />
            </span>
            <span>Portfolio review</span>
          </span>
          {preferences ? <FinancePersonaBadge preferences={preferences} /> : null}
        </header>
        <PortfolioReviewCarousel takeaway={takeaway} model={model} netDeposits={netDeposits} missing={missing} onOpen={onOpen} />
      </section>
    </SurfaceCard>
  );
}

export function SavedPortfolioBriefing({ source, onOpen }: { source: FinanceSource; onOpen: () => void }) {
  const { capture, ready, session } = useFinanceShareContext();
  const { kind, snapshotId, representation } = source;
  const [revision, setRevision] = useState(0);
  const key = useMemo(() => ({
    source: { kind, snapshotId, representation }, ready, session, revision,
  }), [kind, snapshotId, representation, ready, session, revision]);
  const [saved, setSaved] = useState<{
    key: typeof key;
    review?: PortfolioReviewResponse;
    preferences?: PersonaPreferences;
    model?: DashboardViewModel;
    missing?: string;
    isCurrent: () => boolean;
  } | null>(null);

  useEffect(() => {
    if (!key.ready) return;
    const context = capture();
    if (!context) return;

    const invalidate = () => {
      setSaved(null);
      setRevision((value) => value + 1);
    };
    const unsubscribe = subscribeToPkmDomainChanges(({ userId, domain }) => {
      if (userId === context.userId && domain === "financial") invalidate();
    });
    document.addEventListener("visibilitychange", invalidate);
    let disposed = false;

    if (context.isCurrent()) {
      void (async () => {
        const [{ digest, payload, model, preferences }, stored] = await Promise.all([
          readPortfolioReviewInput(context, key.source),
          readSavedPortfolioReview(context).catch(() => null),
        ]);
        if (!disposed && context.isCurrent()) {
          const missing = [
            payload?.horizon === null ? "withdrawal timing" : null,
            payload?.loss_capacity === null ? "ability to absorb losses" : null,
          ].filter(Boolean).join(" and ");
          setSaved({
            key, model, preferences, missing: missing || undefined,
            review: digest === stored?.digest ? stored.review : undefined, isCurrent: context.isCurrent,
          });
        }
      })().catch(() => { /* Keep the review link available if the saved takeaway cannot be opened. */ });
    }

    return () => {
      disposed = true;
      unsubscribe();
      document.removeEventListener("visibilitychange", invalidate);
    };
  }, [capture, key]);

  const current = saved?.key === key && saved.isCurrent() ? saved : null;
  return <PortfolioBriefing
    review={current?.review}
    model={current?.model}
    preferences={current?.preferences}
    netDeposits={kind === "statement" ? current?.model?.summaryMetrics.netDepositsPeriod : null}
    missing={current?.missing}
    onOpen={onOpen}
  />;
}

/** Charts use saved holdings and balance history, never model estimates. */
export function PortfolioAnalysis({ model, loading = false }: { model?: DashboardViewModel; loading?: boolean }) {
  const [drop, setDrop] = useState(20);
  const total = model?.hero.totalValue ?? 0;
  const allocation = (model?.allocation ?? []).filter(({ value }) => Number.isFinite(value) && value > 0);
  const mappedTotal = allocation.reduce((sum, { value }) => sum + value, 0);
  const coverage = mappedTotal / total;
  const showMix = allocation.length > 0 && coverage >= 0.99 && coverage <= 1.01;
  const scenario = portfolioDownsideFacts(model);
  const { stock, weight, investedValue, hasCompleteBalances } = scenario;
  const showHistory = !stock && model?.quality.historyReady === true;
  const cash = model?.canonicalModel.totals.cashValue ?? 0;
  const showScenario = Boolean(stock) || (!showHistory && scenario.canShowInvestedScenario);
  const scenarioTitle = stock ? "What if your largest stock falls?" : "What if your investments fall?";
  const scenarioSubject = scenario.subject;

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
              <div aria-hidden className={`${styles.allocationGlow} grid size-[5.5rem] shrink-0 place-items-center rounded-full`}
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
            <PortfolioDeclineChart drop={drop} />
            <p className={styles.description}>{scenario.assumptions}</p>
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
