"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { PortfolioAnalysis } from "@/components/kai/views/portfolio-briefing";
import { AdvisorReviewError, advisorRequest } from "@/lib/advisor-review/service";
import type { FinanceSource } from "@/lib/finance-sharing/contract";
import { readPortfolioReviewInput } from "@/lib/finance-sharing/portfolio-review-input";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { KaiProfileService, type KaiPreferences } from "@/lib/services/kai-profile-service";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { getReviewSession, setReviewSession } from "@/lib/finance-sharing/portfolio-review-session";
import {
  portfolioReviewCacheGeneration, readSavedPortfolioReview, savePortfolioReviewOnDevice,
  type PortfolioReviewResponse as Review,
} from "@/lib/finance-sharing/portfolio-review-cache";
import { isRequestTimeoutError } from "@/lib/utils/request-timeouts";
import { PortfolioPersona } from "./portfolio-persona";
import styles from "./advisor-review.module.css";

type SavedReviewInput = Awaited<ReturnType<typeof readPortfolioReviewInput>>;

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
  const { kind, snapshotId, representation } = source;
  const sourceKey = useMemo(() => ({ kind, snapshotId, representation }), [kind, snapshotId, representation]);
  const readKey = useMemo(() => ({ sourceKey, revision, sourceRetry }), [sourceKey, revision, sourceRetry]);
  const [saved, setSaved] = useState<{ key: typeof readKey; input: SavedReviewInput | null; cached?: Review } | null>(null);
  const [recentPreferences, setRecentPreferences] = useState<{ sourceKey: typeof sourceKey; value: KaiPreferences } | null>(null);
  const [approval, setApproval] = useState(() => getReviewSession()?.approval.scope === scope ? getReviewSession()!.approval : null);
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{ digest: string; attempt: number; review: Review | null; error?: string } | null>(null);

  useEffect(() => subscribeToPkmDomainChanges(({ userId, domain }) => {
    if (userId === context.userId && domain === "financial") setRevision((value) => value + 1);
  }), [context.userId]);

  useEffect(() => {
    let cancelled = false;
    const current = () => !cancelled && context.isCurrent() && !document.hidden;
    void readPortfolioReviewInput(context, readKey.sourceKey).then(async (input) => {
      if (!current()) return;
      const stored = await readSavedPortfolioReview(context);
      if (!current()) return;
      setRecentPreferences({ sourceKey: readKey.sourceKey, value: input.preferences });
      setSaved({ key: readKey, input, cached: stored?.digest === input.digest ? stored.review : undefined });
    }).catch(async () => {
      if (!current()) return;
      setSaved({ key: readKey, input: null });
      const profile = await KaiProfileService.getProfile(context).catch(() => null);
      if (current() && profile) setRecentPreferences({ sourceKey: readKey.sourceKey, value: profile.preferences });
    });
    return () => { cancelled = true; };
  }, [context, readKey]);

  const input = saved?.key === readKey && context.isCurrent() ? saved.input : null;
  const enabled = approval !== null && approval === getReviewSession()?.approval && approval.scope === scope && (!input || approval.sourceFence === input.sourceFence);
  useEffect(() => {
    if (input && approval && input.sourceFence !== approval.sourceFence) {
      if (getReviewSession()?.approval === approval) setReviewSession(null);
      setApproval(null);
      setSettled(null);
    }
  }, [input, approval]);

  useEffect(() => {
    if (!input || !approval || !enabled || !context.isCurrent() || document.hidden) return;
    const abort = new AbortController();
    const current = () => !abort.signal.aborted && context.isCurrent() && !document.hidden && getReviewSession()?.approval === approval;
    void (async () => {
      try {
        const cached = getReviewSession()?.approval === approval ? getReviewSession()!.cached : undefined;
        const cacheGeneration = cached?.digest === input.digest ? undefined : await portfolioReviewCacheGeneration(context.userId);
        if (!current()) return;
        const review = cached?.digest === input.digest
          ? cached.review
          : await advisorRequest<Review>(context, "/portfolio-analysis", "POST", input.payload, abort.signal);
        if (!current()) return;
        const savedReview = { digest: input.digest, review };
        setReviewSession({ approval, cached: savedReview });
        setSettled({ digest: input.digest, attempt, review });
        setSaved((previous) => previous?.input === input ? { ...previous, cached: review } : previous);
        if (cacheGeneration !== undefined) {
          void savePortfolioReviewOnDevice(context, savedReview, cacheGeneration);
        }
      } catch (error) {
        if (!current()) return;
        const message = isRequestTimeoutError(error) || (error instanceof AdvisorReviewError && error.status === 504)
          ? "The review timed out."
          : error instanceof AdvisorReviewError && error.status === 429
            ? "The review service is busy."
            : "AgentOne couldn’t finish this review.";
        setSettled({ digest: input.digest, attempt, review: null, error: message });
      }
    })();
    return () => abort.abort();
  }, [approval, attempt, context, enabled, input]);

  const result = input && enabled && settled?.digest === input.digest && settled.attempt === attempt ? settled : null;
  const review = result?.review ?? (input ? saved?.cached : undefined);
  const preferences = recentPreferences?.sourceKey === sourceKey ? recentPreferences.value : null;
  const missing = input && [
    input.payload.horizon === null ? "withdrawal timing" : null,
    input.payload.loss_capacity === null ? "ability to absorb losses" : null,
  ].filter(Boolean).join(" and ");
  return (
    <section aria-label="Portfolio review" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <h2 className="ui-text-section-label">Portfolio review</h2>
        {enabled ? (
          <button type="button" className={styles.quietAction} onClick={() => {
            if (getReviewSession()?.approval === approval) setReviewSession(null);
            setSettled(null);
            setApproval(null);
          }}>Turn off automatic review</button>
        ) : null}
      </div>
      <SurfaceCard>
        <SurfaceCardContent className={`${styles.reviewNextStep} space-y-1 px-4 py-3`}>
          {saved?.key === readKey && !input ? (
            <div className={styles.row}>
              <p role="status" className="ui-text-helper-text">The saved portfolio could not be read.</p>
              <button type="button" className={styles.quietAction} onClick={() => setSourceRetry((value) => value + 1)}>Retry</button>
            </div>
          ) : review ? (
            <>
              <h3 className={styles.reviewNextLabel}>Next step</h3>
              <p className="ui-text-row-label-emphasized">{review.next_step}</p>
              <details className="ui-text-row-description">
                <summary className="w-fit cursor-pointer">Why this matters</summary>
                <p>{review.takeaway} {review.reason}</p>
                {review.advisor_reason ? <p>{review.advisor_reason}</p> : null}
              </details>
            </>
          ) : result?.error ? (
            <div className={styles.row}>
              <p role="status" className="ui-text-helper-text">{result.error}</p>
              <button type="button" className={styles.quietAction} onClick={() => setAttempt((value) => value + 1)}>Retry review</button>
            </div>
          ) : enabled ? (
            <p role="status" className="ui-text-helper-text">Reviewing your saved portfolio…</p>
          ) : !input ? (
            <p role="status" className="ui-text-helper-text">Opening your saved review…</p>
          ) : (
            <div className={styles.row}>
              <p id={disclosureId} className="ui-text-helper-text">Allow AgentOne to review this portfolio summary as you save changes. The latest review stays on this device.</p>
              <ShellActionSurface variant="pill" aria-describedby={disclosureId} onClick={() => {
                if (input && context.isCurrent()) {
                  const next = { scope, sourceFence: input.sourceFence };
                  setReviewSession({ approval: next });
                  setApproval(next);
                }
              }}>Allow portfolio review</ShellActionSurface>
            </div>
          )}
        </SurfaceCardContent>
      </SurfaceCard>
      <PortfolioAnalysis model={input?.model} loading={saved?.key !== readKey} />
      {preferences || review ? (
        <SurfaceCard>
          <SurfaceCardContent className="space-y-2 px-4 py-2">
            {preferences ? (
              <PortfolioPersona context={context} preferences={preferences} onSaved={(value) => {
                setRecentPreferences({ sourceKey, value });
              }} />
            ) : null}
            {review ? (
              <div className={styles.row}>
                <h3 className="ui-text-section-label">Portfolio score</h3>
                {review.score !== null ? (
                  <p className="ui-text-row-description tabular-nums"><strong className="ui-text-row-label-emphasized">{review.score}</strong> / 100</p>
                ) : <p className="ui-text-helper-text">{missing ? `Add ${missing}` : "Unavailable"}</p>}
              </div>
            ) : null}
          </SurfaceCardContent>
        </SurfaceCard>
      ) : null}
    </section>
  );
}
