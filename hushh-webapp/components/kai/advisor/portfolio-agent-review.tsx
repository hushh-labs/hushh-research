"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { topPortfolioWeights } from "@/components/kai/views/portfolio-analysis-facts";
import { AdvisorReviewError, advisorRequest } from "@/lib/advisor-review/service";
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
import { isRequestTimeoutError } from "@/lib/utils/request-timeouts";
import styles from "./advisor-review.module.css";

type Review = {
  score: number | null;
  takeaway: string;
  reason: string;
  next_step: string;
  advisor_reason: string | null;
};

type ReviewApproval = { scope: string };
type ReviewSession = { approval: ReviewApproval; cached?: { digest: string; review: Review } };
type ReviewRequest = {
  approval: ReviewApproval;
  context: FinanceShareContext;
  model: DashboardViewModel;
  revision: number;
  kind: FinanceSource["kind"];
  snapshotId: FinanceSource["snapshotId"];
};
const reviewFailureMessages = {
  source: "The saved portfolio could not be read. Refresh the portfolio source and try again.",
  timeout: "The review timed out. You can try again.",
  rateLimit: "The review service is busy. Wait a moment and try again.",
  access: "Review access could not be confirmed. Check that your vault is unlocked and try again.",
  unavailable: "Agent One couldn’t finish this review.",
};
type ReviewFailure = keyof typeof reviewFailureMessages;

function classifyReviewFailure(error: unknown, readingSource: boolean): ReviewFailure {
  if (isRequestTimeoutError(error) || (error instanceof AdvisorReviewError && error.status === 504)) return "timeout";
  if (readingSource) return "source";
  if (error instanceof AdvisorReviewError) {
    if (error.status === 429) return "rateLimit";
    if ([401, 403, 409].includes(error.status)) return "access";
  }
  return "unavailable";
}
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
  persona,
  onFindAdvisor,
}: {
  context: FinanceShareContext;
  source: FinanceSource;
  model: DashboardViewModel;
  scope: string;
  personaRevision: number;
  persona?: ReactNode;
  onFindAdvisor: () => void;
}) {
  const disclosureId = useId();
  const [request, setRequest] = useState<ReviewRequest | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{
    request: ReviewRequest;
    attempt: number;
    review: Review | null;
    failure?: ReviewFailure;
  } | null>(null);
  const { kind, snapshotId } = source;
  const active = request &&
    request.approval === approved?.approval &&
    request.approval.scope === scope &&
    request.context === context &&
    request.model === model &&
    request.revision === personaRevision &&
    request.kind === kind &&
    request.snapshotId === snapshotId &&
    context.isCurrent() ? request : null;
  if (request && !active) {
    setRequest(null);
    setSettled(null);
  }
  const result = active && settled?.request === active && settled.attempt === attempt
    ? settled
    : null;

  function closeReview() {
    setRequest(null);
    setSettled(null);
  }

  function askForReview(open: boolean) {
    if (!open) {
      closeReview();
      return;
    }
    if (!context.isCurrent()) return;
    const approval = approved?.approval.scope === scope ? approved.approval : { scope };
    if (approved?.approval !== approval) approved = { approval };
    setAttempt(0);
    setRequest({ approval, context, model, revision: personaRevision, kind, snapshotId });
  }

  useEffect(() => {
    const request = active;
    if (!request) return;
    const { approval, context, kind, snapshotId } = request;
    const abort = new AbortController();
    const current = () =>
      !abort.signal.aborted && context.isCurrent() && approved?.approval === approval;

    const runReview = async () => {
      let readingSource = true;
      try {
        const { payload, digest } = await reviewInput(context, { kind, snapshotId });
        if (!current()) return;
        readingSource = false;
        const cached = approved?.approval === approval ? approved.cached : undefined;
        const review =
          cached?.digest === digest
            ? cached.review
            : await advisorRequest<Review>(
                context,
                "/portfolio-analysis",
                "POST",
                payload,
                abort.signal,
              );
        if (!current()) return;
        approved = { approval, cached: { digest, review } };
        setSettled({ request, attempt, review });
      } catch (error) {
        if (current()) {
          setSettled({
            request,
            attempt,
            review: null,
            failure: classifyReviewFailure(error, readingSource),
          });
        }
      }
    };

    void runReview();
    return () => abort.abort();
  }, [active, attempt]);

  const review = result?.review;
  return (
    <Sheet modal open={active !== null} onOpenChange={askForReview}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SheetTrigger asChild>
          <ShellActionSurface variant="pill" className="min-h-11 ui-text-compact-button-label" aria-describedby={disclosureId}>
            Ask Agent One to review
          </ShellActionSurface>
        </SheetTrigger>
        <p id={disclosureId} className="ui-text-helper-text">
          Uses a summary of your holdings, allocation and investing preferences.
        </p>
      </div>
      <SheetContent
        side="bottom"
        className={`${styles.reviewSheet} mx-auto max-h-[85dvh] max-w-2xl overflow-y-auto`}
        data-app-type-context="overlay"
      >
        <SheetHeader>
          <SheetTitle>Agent One’s review</SheetTitle>
          <SheetDescription className="ui-text-row-description">Based on your saved portfolio.</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          {!result ? (
            <p role="status">Reviewing your saved portfolio…</p>
          ) : !review ? (
            <div className={styles.row}>
              <p role="status">{reviewFailureMessages[result.failure ?? "unavailable"]}</p>
              <button
                type="button"
                className={styles.quietAction}
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </button>
            </div>
          ) : (
            <div className={styles.reviewSummary}>
              <div>
                <h3 className="ui-text-section-label">{review.takeaway}</h3>
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
              <ShellActionSurface variant="pill" className="min-h-11 ui-text-compact-button-label" onClick={() => {
                closeReview();
                onFindAdvisor();
              }}>
                Talk to an advisor
              </ShellActionSurface>
            </div>
          ) : null}
          {persona}
        </div>
      </SheetContent>
    </Sheet>
  );
}
