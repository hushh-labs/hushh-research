"use client";

import { useEffect, useMemo, useState } from "react";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { ChevronRight } from "@/components/icons";
import { formatMinor } from "@/lib/mail/receipt-money";
import { type ReceiptInsight, findCancellationProof } from "@/lib/mail/receipt-insights";
import { riseFacts } from "@/lib/mail/receipt-tracking-present";
import { confirmCancellation, confirmedSavings, pendingCancellations, recordInsightReviewed, savePlanReview } from "@/lib/mail/receipt-tracking";
import type { RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import { cn } from "@/lib/utils";
import mailStyles from "../mail-workspace.module.css";
import { useReceiptTracking } from "./receipt-tracking-context";
import styles from "./receipts.module.css";

/** Insights the owner already marked as not an issue stay hidden for this mailbox. */
export function useVisibleInsights(insights: readonly ReceiptInsight[]): ReceiptInsight[] {
  const tracking = useReceiptTracking();
  const dismissed = useMemo(() => new Set((tracking?.doc?.dismissed ?? []).map((item) => item.id)), [tracking?.doc?.dismissed]);
  return useMemo(() => insights.filter((insight) => !dismissed.has(insight.id)), [insights, dismissed]);
}

/**
 * A cancellation stays pending until the provider's own cancellation receipt arrives after the choice.
 * Nothing else, not the choice itself, counts as confirmation or as savings.
 */
export function useCancellationConfirmation(rows: readonly RecentReceiptRow[]): void {
  const tracking = useReceiptTracking();
  const doc = tracking?.doc ?? null;
  const apply = tracking?.apply;
  useEffect(() => {
    if (!doc || !apply) return;
    for (const pending of pendingCancellations(doc)) {
      const proof = findCancellationProof(rows, pending.plan.key, pending.requestedAt);
      if (proof) void apply((current, ctx) => confirmCancellation(current, pending.insightId, pending.plan.key, proof.primaryReceiptKey, ctx));
    }
  }, [doc, apply, rows]);
}

export function InsightCard({
  insight, total, onSeeAll, onReview, waitingNote,
}: {
  insight: ReceiptInsight | null;
  total: number;
  onSeeAll: () => void;
  onReview: (insight: ReceiptInsight) => void;
  /** Shown when nothing new was noticed but a cancellation still awaits its provider. */
  waitingNote?: { title: string; detail: string } | null;
}) {
  if (!insight && !waitingNote) return null;
  return (
    <section aria-label="One noticed" className="rounded-[20px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4 shadow-[var(--shadow-xs)] sm:p-5" data-testid="insight-card">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[13px] leading-[18px] font-semibold text-[color:var(--app-accent)]">
          <span aria-hidden="true" className="size-2 rounded-full bg-[color:var(--app-accent)]" />
          One noticed
        </p>
        <button type="button" onClick={onSeeAll} className="min-h-11 px-1 text-[14px] font-medium text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]">
          See all{total > 1 ? ` (${total})` : ""}
        </button>
      </div>
      <div className="mt-1 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h3 className={cn(styles.cardTitle, "text-foreground")}>{insight?.title ?? waitingNote?.title}</h3>
          <p className="mt-1 text-[14px] leading-[21px] text-muted-foreground">{insight?.reason ?? waitingNote?.detail}</p>
        </div>
        {insight ? (
          <button type="button" onClick={() => onReview(insight)} className={cn(styles.primaryPill, "shrink-0")}>
            {insight.action.label}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function InsightsSheet({
  open, onOpenChange, insights, onReview,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  insights: readonly ReceiptInsight[];
  onReview: (insight: ReceiptInsight) => void;
}) {
  const doc = useReceiptTracking()?.doc ?? null;
  const savings = Object.entries(doc ? confirmedSavings(doc) : {}).filter(([, minor]) => minor > 0);
  const waiting = doc ? pendingCancellations(doc) : [];
  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={onOpenChange}
      title="What One noticed"
      description="Each item links the receipts behind it. Nothing is cancelled or paid for you."
      surfaceClassName={`${mailStyles.typography} ${mailStyles.portal}`}
      mobilePresentation="sheet"
      desktopMaxWidthClassName="sm:!max-w-[520px]"
    >
      <div className="space-y-3" data-testid="insights-list">
        {savings.length ? (
          <p className="rounded-xl bg-emerald-500/10 px-4 py-3 text-[14px] leading-[21px] text-foreground" role="status">
            Saved {savings.map(([currency, minor]) => `${formatMinor(minor, currency)} a month`).join(" and ")}, confirmed by the provider.
          </p>
        ) : null}
        {waiting.length ? (
          <p className="rounded-xl bg-muted/60 px-4 py-3 text-[14px] leading-[21px] text-muted-foreground" role="status">
            Waiting for {waiting.map((item) => item.plan.label).join(", ")} to confirm the cancellation. Savings count only after they do.
          </p>
        ) : null}
        {insights.length ? insights.map((insight) => (
          <button
            key={insight.id}
            type="button"
            onClick={() => onReview(insight)}
            className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
          >
            <span className="min-w-0">
              <span className="block text-[14px] leading-[21px] font-semibold text-foreground">{insight.title}</span>
              <span className="block text-[12px] leading-[18px] text-muted-foreground">{insight.reason}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[13px] font-medium text-[color:var(--app-accent)]">{insight.action.label}<ChevronRight aria-hidden="true" className="size-4" /></span>
          </button>
        )) : <p className="text-[14px] leading-[21px] text-muted-foreground" role="status">Nothing needs a look right now. One checks again whenever your receipts update.</p>}
      </div>
    </AdaptiveDetailSurface>
  );
}

export function InsightReviewSheet({
  insight, onClose, rows, onOpenReceipt,
}: {
  insight: ReceiptInsight | null;
  onClose: () => void;
  rows: readonly RecentReceiptRow[];
  onOpenReceipt: (receiptKey: string) => void;
}) {
  const tracking = useReceiptTracking();
  const saved = useMemo(() => tracking?.doc?.reviews.find((review) => review.insightId === insight?.id) ?? null, [tracking?.doc?.reviews, insight?.id]);
  const [choices, setChoices] = useState<Record<string, "keep" | "cancel">>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    setChoices(saved?.choices ?? {});
    setMessage(null);
  }, [insight?.id, saved]);
  const canSave = tracking?.status === "ready";
  const supporting = (insight?.rowIds ?? []).map((id) => rows.find((row) => row.id === id)).filter((row): row is RecentReceiptRow => Boolean(row));

  const save = async () => {
    if (!insight?.plans || !tracking) return;
    setBusy(true);
    const plans = insight.plans.map((plan) => ({ key: plan.key, label: plan.label, monthlyMinor: plan.monthlyMinor, currency: plan.currency }));
    const full = Object.fromEntries(insight.plans.map((plan) => [plan.key, choices[plan.key] ?? "keep"] as const));
    const ok = await tracking.apply((doc, ctx) => savePlanReview(doc, { insightId: insight.id, reason: insight.reason, plans, choices: full }, ctx));
    setBusy(false);
    setMessage(ok ? "Saved. One doesn’t cancel anything for you: cancel with each provider. Savings count once the provider confirms." : tracking.saveError);
  };

  const notAnIssue = async () => {
    if (!insight || !tracking) return;
    setBusy(true);
    const ok = await tracking.apply((doc, ctx) => recordInsightReviewed(doc, insight.id, insight.title, ctx));
    setBusy(false);
    if (ok) onClose();
    else setMessage(tracking.saveError);
  };

  const planStatus = (key: string): string | null => {
    const choice = saved?.choices[key];
    if (!choice) return null;
    if (choice === "keep") return "Keeping";
    return saved?.confirmed[key] ? "Cancelled · the provider confirmed" : "Marked to cancel · waiting for the provider to confirm";
  };

  return (
    <AdaptiveDetailSurface
      open={Boolean(insight)}
      onOpenChange={(open) => { if (!open) onClose(); }}
      eyebrow="One noticed"
      headerTextOverflow="wrap"
      title={insight?.title ?? ""}
      description={insight?.reason}
      surfaceClassName={`${mailStyles.typography} ${mailStyles.portal}`}
      mobilePresentation="sheet"
      desktopMaxWidthClassName="sm:!max-w-[520px]"
      footer={insight ? (
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
          {insight.kind === "overlapping_plans" ? (
            <button type="button" onClick={() => void save()} disabled={busy || !canSave} className={styles.primaryPill}>Save choices</button>
          ) : null}
          <button type="button" onClick={() => (insight.kind === "overlapping_plans" ? onClose() : void notAnIssue())} disabled={busy} className={styles.secondaryPill}>
            {insight.kind === "overlapping_plans" ? "Not now" : "Not an issue"}
          </button>
        </div>
      ) : undefined}
    >
      {insight ? (
        <div className="space-y-4" data-testid="insight-review">
          {insight.kind === "overlapping_plans" && insight.plans ? (
            <>
              <p className="text-[14px] leading-[21px] text-muted-foreground">Choose what to keep. Each plan links its latest receipt.</p>
              <ul className="divide-y divide-border/60 rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]">
                {insight.plans.map((plan) => {
                  const choice = choices[plan.key] ?? "keep";
                  const status = planStatus(plan.key);
                  return (
                    <li key={plan.key} className="space-y-2 px-4 py-3" data-testid="insight-plan">
                      <div className="flex items-center justify-between gap-3">
                        <button type="button" onClick={() => onOpenReceipt(plan.receiptKey)} className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]">
                          <span className="block truncate text-[14px] leading-[21px] font-semibold text-foreground">{plan.label}</span>
                          <span className="block text-[12px] leading-[18px] text-muted-foreground">{formatMinor(plan.minor, plan.currency)}{plan.monthlyMinor !== null ? " a month" : ""} · View receipt</span>
                        </button>
                        <div role="radiogroup" aria-label={`${plan.label}: keep or cancel`} className="flex shrink-0 overflow-hidden rounded-full border border-[color:var(--app-card-border-standard)]">
                          {(["keep", "cancel"] as const).map((option) => (
                            <button
                              key={option}
                              type="button"
                              role="radio"
                              aria-checked={choice === option}
                              onClick={() => setChoices((previous) => ({ ...previous, [plan.key]: option }))}
                              className={cn("min-h-11 min-w-[68px] px-3 text-[13px] font-semibold capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent-ring)]", choice === option ? (option === "cancel" ? "bg-[color:var(--app-destructive-tint)] text-[color:var(--app-destructive-deep)]" : "bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)]") : "text-muted-foreground")}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </div>
                      {status ? <p className="text-[12px] leading-[18px] text-muted-foreground" role="status">{status}</p> : null}
                    </li>
                  );
                })}
              </ul>
              {!canSave ? <p className="text-[12px] leading-[18px] text-muted-foreground" role="status">Saving choices isn’t available right now. You can still review the plans.</p> : null}
            </>
          ) : (
            <>
              {insight.rise ? (
                <dl className="divide-y divide-border/60 rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] px-4 text-[13px]">
                  {riseFacts(insight.rise).map((fact) => <div key={fact.label} className="flex justify-between gap-3 py-2"><dt className="text-muted-foreground">{fact.label}</dt><dd className="font-medium tabular-nums">{fact.value}</dd></div>)}
                </dl>
              ) : null}
              <p className="text-[14px] leading-[21px] text-muted-foreground">These are the receipts behind this. Open one to see its source email.</p>
              <ul className="divide-y divide-border/60 rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]">
                {supporting.map((row) => (
                  <li key={row.id}>
                    <button type="button" onClick={() => onOpenReceipt(row.primaryReceiptKey)} className="flex min-h-[56px] w-full items-center justify-between gap-3 px-4 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]">
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] leading-[21px] font-semibold text-foreground">{row.merchantName}</span>
                        <span className="block text-[12px] leading-[18px] text-muted-foreground">{row.receiptDate ? new Date(row.receiptDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "Date unknown"} · {row.status === "cancelled" || row.eventTimeline[0]?.eventKind === "cancellation" ? "Cancellation" : "Payment"}</span>
                      </span>
                      <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {message ? <p className="text-[13px] leading-[19px] text-muted-foreground" role="status">{message}</p> : null}
        </div>
      ) : null}
    </AdaptiveDetailSurface>
  );
}
