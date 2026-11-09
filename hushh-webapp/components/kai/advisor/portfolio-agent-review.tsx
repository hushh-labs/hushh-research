"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { PortfolioAnalysis } from "@/components/kai/views/portfolio-briefing";
import { topPortfolioWeights } from "@/components/kai/views/portfolio-analysis-facts";
import { AdvisorReviewError, advisorRequest } from "@/lib/advisor-review/service";
import { financeDigest, type FinanceSource } from "@/lib/finance-sharing/contract";
import { readSavedFinance } from "@/lib/finance-sharing/saved-source";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { KaiProfileService, type KaiPreferences } from "@/lib/services/kai-profile-service";
import { getInvestingPersona, portfolioPlanningSignals } from "@/lib/kai/investing-persona";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { isRequestTimeoutError } from "@/lib/utils/request-timeouts";
import { PortfolioPersona } from "./portfolio-persona";
import styles from "./advisor-review.module.css";

type Review = {
  score: number | null;
  takeaway: string;
  reason: string;
  next_step: string;
  advisor_reason: string | null;
};
type SavedReviewInput = Awaited<ReturnType<typeof reviewInput>>;
type ReviewApproval = { scope: string; sourceFence: string };
type ReviewSession = { approval: ReviewApproval; cached?: { digest: string; review: Review } };
let reviewSession: ReviewSession | null = null;
if (typeof window !== "undefined") {
  subscribeVaultSessionEpoch(() => { reviewSession = null; });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) reviewSession = null;
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
  return { payload, digest, sourceFence, model, preferences };
}

export function PortfolioAgentReview({
  context,
  source,
  scope,
}: {
  context: FinanceShareContext;
  source: FinanceSource;
  scope: string;
}) {
  const disclosureId = useId();
  const [revision, setRevision] = useState(0);
  const [sourceRetry, setSourceRetry] = useState(0);
  const { kind, snapshotId } = source;
  const sourceKey = useMemo(() => ({ kind, snapshotId }), [kind, snapshotId]);
  const readKey = useMemo(() => ({ sourceKey, revision, sourceRetry }), [sourceKey, revision, sourceRetry]);
  const [saved, setSaved] = useState<{ key: typeof readKey; input: SavedReviewInput | null } | null>(null);
  const [recentPreferences, setRecentPreferences] = useState<{ sourceKey: typeof sourceKey; value: KaiPreferences } | null>(null);
  const [approval, setApproval] = useState(() => reviewSession?.approval.scope === scope ? reviewSession.approval : null);
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{ digest: string; attempt: number; review: Review | null; error?: string } | null>(null);

  useEffect(() => subscribeToPkmDomainChanges(({ userId, domain }) => {
    if (userId === context.userId && domain === "financial") setRevision((value) => value + 1);
  }), [context.userId]);

  useEffect(() => {
    let cancelled = false;
    const current = () => !cancelled && context.isCurrent() && !document.hidden;
    void reviewInput(context, readKey.sourceKey).then((input) => {
      if (!current()) return;
      setRecentPreferences({ sourceKey: readKey.sourceKey, value: input.preferences });
      setSaved({ key: readKey, input });
    }).catch(async () => {
      if (!current()) return;
      setSaved({ key: readKey, input: null });
      const profile = await KaiProfileService.getProfile(context).catch(() => null);
      if (current() && profile) setRecentPreferences({ sourceKey: readKey.sourceKey, value: profile.preferences });
    });
    return () => { cancelled = true; };
  }, [context, readKey]);

  const input = saved?.key === readKey && context.isCurrent() ? saved.input : null;
  const enabled = approval !== null && approval === reviewSession?.approval && approval.scope === scope && (!input || approval.sourceFence === input.sourceFence);
  useEffect(() => {
    if (input && approval && input.sourceFence !== approval.sourceFence) {
      if (reviewSession?.approval === approval) reviewSession = null;
      setApproval(null);
      setSettled(null);
    }
  }, [input, approval]);

  useEffect(() => {
    if (!input || !approval || !enabled || !context.isCurrent() || document.hidden) return;
    const abort = new AbortController();
    const current = () => !abort.signal.aborted && context.isCurrent() && !document.hidden && reviewSession?.approval === approval;
    void (async () => {
      try {
        const cached = reviewSession?.approval === approval ? reviewSession.cached : undefined;
        const review = cached?.digest === input.digest
          ? cached.review
          : await advisorRequest<Review>(context, "/portfolio-analysis", "POST", input.payload, abort.signal);
        if (!current()) return;
        reviewSession = { approval, cached: { digest: input.digest, review } };
        setSettled({ digest: input.digest, attempt, review });
      } catch (error) {
        if (!current()) return;
        const message = isRequestTimeoutError(error) || (error instanceof AdvisorReviewError && error.status === 504)
          ? "The review timed out."
          : error instanceof AdvisorReviewError && error.status === 429
            ? "The review service is busy."
            : "The private agent couldn’t finish this review.";
        setSettled({ digest: input.digest, attempt, review: null, error: message });
      }
    })();
    return () => abort.abort();
  }, [approval, attempt, context, enabled, input]);

  const result = input && enabled && settled?.digest === input.digest && settled.attempt === attempt ? settled : null;
  const review = result?.review;
  const preferences = recentPreferences?.sourceKey === sourceKey ? recentPreferences.value : null;
  const missing = input && [
    input.payload.horizon === null ? "withdrawal timing" : null,
    input.payload.loss_capacity === null ? "ability to absorb losses" : null,
  ].filter(Boolean).join(" and ");
  return (
    <section aria-label="Portfolio review" className="space-y-3">
      <SurfaceCard>
        <SurfaceCardContent className="space-y-3 p-4">
          <h2 className="ui-text-section-label">Portfolio review</h2>
          {preferences ? (
            <PortfolioPersona context={context} preferences={preferences} onSaved={(value) => {
              setRecentPreferences({ sourceKey, value });

            }} />
          ) : null}
          {saved?.key === readKey && !input ? (
            <div className={styles.row}>
              <p role="status" className="ui-text-helper-text">The saved portfolio could not be read.</p>
              <button type="button" className={styles.quietAction} onClick={() => setSourceRetry((value) => value + 1)}>Retry</button>
            </div>
          ) : enabled ? (
            <>
              {review ? (
                <div className={styles.row}>
                  <div className="min-w-0 flex-1 space-y-1">
                    <h3 className="ui-text-section-label">Next step</h3>
                    <p>{review.next_step}</p>
                    <details className="ui-text-helper-text">
                      <summary>Why this matters</summary>
                      <p>{review.takeaway} {review.reason}</p>
                      {review.advisor_reason ? <p>{review.advisor_reason}</p> : null}
                    </details>
                  </div>
                  <div className="shrink-0 space-y-1">
                    <span className="ui-text-helper-text">Snapshot score</span>
                    {review.score !== null ? (
                      <p><strong>{review.score} / 100</strong></p>
                    ) : <p className="ui-text-helper-text">{missing ? `Add ${missing}` : "Unavailable"}</p>}
                  </div>
                </div>
              ) : result?.error ? (
                <div className={styles.row}>
                  <p role="status" className="ui-text-helper-text">{result.error}</p>
                  <button type="button" className={styles.quietAction} onClick={() => setAttempt((value) => value + 1)}>Retry review</button>
                </div>
              ) : <p role="status" className="ui-text-helper-text">Reviewing your saved portfolio…</p>}
              <button type="button" className={styles.quietAction} onClick={() => {
                if (reviewSession?.approval === approval) reviewSession = null;
                setSettled(null);
                setApproval(null);
              }}>Turn off automatic review</button>
            </>
          ) : (
            <div className={styles.row}>
              <p id={disclosureId} className="ui-text-helper-text">Allow the private agent to use a summary of this saved portfolio and refresh its review when you save changes.</p>
              <ShellActionSurface variant="pill" disabled={!input} aria-describedby={disclosureId} onClick={() => {
                if (input && context.isCurrent()) {
                  const next = { scope, sourceFence: input.sourceFence };
                  reviewSession = { approval: next };
                  setApproval(next);
                }
              }}>Enable automatic review</ShellActionSurface>
            </div>
          )}
        </SurfaceCardContent>
      </SurfaceCard>
      {input ? <PortfolioAnalysis model={input.model} /> : null}
    </section>
  );
}
