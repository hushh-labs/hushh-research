"use client";

import { useEffect, useState } from "react";
import { Activity } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { topPortfolioWeights } from "@/components/kai/views/portfolio-analysis-facts";
import { advisorRequest } from "@/lib/advisor-review/service";
import {
  financeDigest,
  type FinanceSource,
} from "@/lib/finance-sharing/contract";
import { readSavedFinance } from "@/lib/finance-sharing/saved-source";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import {
  getInvestingPersona,
  portfolioPlanningSignals,
} from "@/lib/kai/investing-persona";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import styles from "./advisor-review.module.css";

type Review = {
  score: number | null;
  takeaway: string;
  reason: string;
  next_step: string;
  advisor_reason: string | null;
};

type ReviewSession = { scope: string; digest?: string; review?: Review };
let approved: ReviewSession | null = null;
if (typeof window !== "undefined") {
  subscribeVaultSessionEpoch(() => {
    approved = null;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) approved = null;
  });
}

async function reviewInput(
  context: FinanceShareContext,
  source: FinanceSource,
) {
  const { model, profile, sourceFence } = await readSavedFinance(
    context,
    source,
    true,
  );
  const preferences = profile.preferences;
  const { horizon, lossCapacity } = portfolioPlanningSignals(preferences);
  const top = topPortfolioWeights(model);
  const total = model.hero.totalValue;
  const allocation = model.allocation
    .flatMap(({ name, value }) =>
      total > 0 && value > 0 && value <= total
        ? [{ name: name.slice(0, 60), percent: (value / total) * 100 }]
        : [],
    )
    .slice(0, 8);
  const allocationCoverage = allocation.reduce(
    (sum, row) => sum + row.percent,
    0,
  );
  const payload = {
    allow_model_processing: true,
    position_count: model.hero.holdingsCount,
    top_positions: top.map((row) => ({ ...row, name: row.name.slice(0, 60) })),
    allocation,
    history_available: model.quality.historyReady,
    persona: getInvestingPersona(preferences).kind,
    horizon,
    loss_capacity: lossCapacity,
    assessable:
      top.length > 0 &&
      allocationCoverage >= 99 &&
      allocationCoverage <= 101 &&
      model.canonicalModel.positions.every(
        (row) => Number.isFinite(row.marketValue) && row.marketValue >= 0,
      ) &&
      horizon !== null &&
      lossCapacity !== null,
  };
  const digest = await financeDigest(
    JSON.stringify([
      "portfolio-review-v1",
      sourceFence,
      payload,
      total,
      model.canonicalModel.positions.map((row) => [row.id, row.marketValue]),
      model.history,
    ]),
  );
  return { payload, digest };
}

/** One user-approved, nonpersisting review per saved input. */
export function PortfolioAgentReview({
  context,
  source,
  model,
  scope,
  personaRevision,
  onFindAdvisor,
}: {
  context: FinanceShareContext;
  source: FinanceSource;
  model: DashboardViewModel;
  scope: string;
  personaRevision: number;
  onFindAdvisor: () => void;
}) {
  const [enabled, setEnabled] = useState(() => approved?.scope === scope);
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{
    model: DashboardViewModel;
    revision: number;
    attempt: number;
    source: string;
    review: Review | null;
  } | null>(null);
  const { kind, snapshotId } = source;
  const sourceKey = `${kind}:${snapshotId ?? ""}`;
  const result =
    settled?.model === model &&
    settled.revision === personaRevision &&
    settled.attempt === attempt &&
    settled.source === sourceKey
      ? settled
      : null;

  useEffect(() => {
    if (!enabled || !context.isCurrent() || approved?.scope !== scope) return;
    const approval = approved;
    const abort = new AbortController();
    const current = () =>
      !abort.signal.aborted && context.isCurrent() && approved === approval;
    const timeout = window.setTimeout(async () => {
      try {
        const { payload, digest } = await reviewInput(context, {
          kind,
          snapshotId,
        });
        if (!current()) return;
        const review =
          approval.digest === digest && approval.review
            ? approval.review
            : await advisorRequest<Review>(
                context,
                "/portfolio-analysis",
                "POST",
                payload,
                abort.signal,
              );
        if (!current()) return;
        approval.digest = digest;
        approval.review = review;
        setSettled({
          model,
          revision: personaRevision,
          attempt,
          source: sourceKey,
          review,
        });
      } catch {
        if (current())
          setSettled({
            model,
            revision: personaRevision,
            attempt,
            source: sourceKey,
            review: null,
          });
      }
    }, 350);
    return () => {
      window.clearTimeout(timeout);
      abort.abort();
    };
  }, [
    enabled,
    context,
    kind,
    snapshotId,
    sourceKey,
    model,
    scope,
    personaRevision,
    attempt,
  ]);

  const review = result?.review;
  return (
    <section className={styles.card} aria-label="Agent One portfolio review">
      <div className={styles.row}>
        <h2 className="flex items-center gap-2 ui-text-section-label">
          <Activity
            className="size-4 text-[var(--app-accent)]"
            aria-hidden="true"
          />
          Agent One’s review
        </h2>
        {review ? (
          <span role="status" className="ui-text-helper-text">
            Up to date
          </span>
        ) : null}
        {enabled ? (
          <ShellActionSurface
            variant="pill"
            onClick={() => {
              approved = null;
              setEnabled(false);
              setSettled(null);
            }}
          >
            Turn off auto-review
          </ShellActionSurface>
        ) : (
          <ShellActionSurface
            variant="pill"
            className={styles.primary}
            onClick={() => {
              if (!context.isCurrent()) return;
              approved = { scope };
              setEnabled(true);
            }}
          >
            Enable auto-review
          </ShellActionSurface>
        )}
      </div>
      {!enabled ? (
        <p className="ui-text-helper-text">
          Let Agent One review holding weights, allocation and your persona
          while One is unlocked.
        </p>
      ) : !result ? (
        <p role="status">Reviewing your saved portfolio…</p>
      ) : !review ? (
        <div className={styles.row}>
          <p role="status">Agent One couldn’t finish this review.</p>
          <ShellActionSurface
            variant="pill"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </ShellActionSurface>
        </div>
      ) : (
        <div className={styles.reviewSummary}>
          <div>
            <h3 className="text-lg font-semibold">{review.takeaway}</h3>
            <p className="ui-text-helper-text">{review.reason}</p>
            <p>
              <strong>Next step</strong> · {review.next_step}
            </p>
          </div>
          {review.score !== null ? (
            <div className={styles.reviewScore}>
              <span>Snapshot score</span>
              <strong>
                {review.score}
                <small> / 100</small>
              </strong>
              <meter
                min={0}
                max={100}
                value={review.score}
                aria-label="Snapshot score"
              />
            </div>
          ) : (
            <p className="ui-text-helper-text">Score unavailable</p>
          )}
        </div>
      )}
      {review?.score != null ? (
        <details className="ui-text-helper-text">
          <summary>How the score works</summary>
          <p>
            Agent One weighs position spread (40 points), asset mix (30), and
            fit with your withdrawal timing and ability to absorb losses (30).
            The score reflects this saved snapshot.
          </p>
        </details>
      ) : null}
      {result && (!review || review.advisor_reason) ? (
        <div className={`${styles.notice} ${styles.row} mt-3`}>
          <p className="ui-text-helper-text">
            {review?.advisor_reason ??
              "A verified advisor can review this portfolio with you."}
          </p>
          <ShellActionSurface variant="pill" onClick={onFindAdvisor}>
            Talk to an advisor
          </ShellActionSurface>
        </div>
      ) : null}
    </section>
  );
}
