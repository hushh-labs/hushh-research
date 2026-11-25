"use client";

import { useEffect, useMemo, useState } from "react";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { ChevronRight } from "@/components/icons";
import { formatMinor } from "@/lib/mail/receipt-money";
import { type ReceiptInsight, buildReceiptInsights, findCancellationProof } from "@/lib/mail/receipt-insights";
import { type NoticeEvidence, noticeInsight, noticePlanKey, providerCancellationFor } from "@/lib/mail/receipt-notice";
import { riseFacts, shortDate } from "@/lib/mail/receipt-tracking-present";
import { confirmCancellation, confirmedSavings, pendingCancellations, recordInsightReviewed, savePlanReview } from "@/lib/mail/receipt-tracking";
import type { RecentReceiptRow } from "@/lib/profile/gmail-receipt-presentation";
import { cn } from "@/lib/utils";
import mailStyles from "../mail-workspace.module.css";
import { EvidenceList, NoticeFacts, NoticeSourceSheet, noticeCaveat } from "./notice-review";
import { useReceiptNotice } from "./receipt-notice-context";
import { useReceiptTracking } from "./receipt-tracking-context";
import styles from "./receipts.module.css";

/**
 * Findings the owner already answered stay out of the way for this mailbox: marked not an issue or kept, and,
 * for a mailbox check's finding, one whose plan choices were saved (a receipts-only plan review keeps showing
 * its saved status instead).
 */
export function useVisibleInsights(insights: readonly ReceiptInsight[]): ReceiptInsight[] {
  const tracking = useReceiptTracking();
  const dismissed = useMemo(() => new Set((tracking?.doc?.dismissed ?? []).map((item) => item.id)), [tracking?.doc?.dismissed]);
  const reviewed = useMemo(() => new Set((tracking?.doc?.reviews ?? []).map((item) => item.insightId)), [tracking?.doc?.reviews]);
  return useMemo(
    () => insights.filter((insight) => !dismissed.has(insight.id) && !(insight.origin === "notice" && reviewed.has(insight.id))),
    [insights, dismissed, reviewed],
  );
}

export interface NoticeSurface {
  insights: ReceiptInsight[];
  /** "notice": One's mailbox check made them. "receipts": read from the saved receipts, with no mailbox check behind them. */
  origin: "notice" | "receipts";
  /** A short quiet line about how current they are, or null when they are fresh. */
  caption: string | null;
  canRetry: boolean;
  retry: () => void;
}

/**
 * What the card and the list show. Findings One's mailbox check made come first and are never mixed with the
 * receipts-only ones. Until a check has worked once for this mailbox, the receipts-only findings stand in and
 * are labelled as such; a failed check never turns them into a fresh check.
 */
export function useNoticeInsights(rows: readonly RecentReceiptRow[]): NoticeSurface {
  const tracking = useReceiptTracking();
  const notice = useReceiptNotice();
  const saved = tracking?.doc?.notice ?? null;
  const checked = Boolean(saved?.checkedAt);
  const fromNotice = useMemo(() => (saved?.findings ?? []).map(noticeInsight), [saved?.findings]);
  const fromReceipts = useMemo(() => (checked ? [] : buildReceiptInsights(rows)), [checked, rows]);
  const visibleNotice = useVisibleInsights(fromNotice);
  const visibleReceipts = useVisibleInsights(fromReceipts);
  const failed = notice?.status === "failed";
  const checking = notice?.status === "checking";
  let caption: string | null = null;
  if (checked) {
    if (checking) caption = "Checking for updates";
    else if (failed) caption = saved?.checkedAt ? `Couldn’t update. From ${shortDate(saved.checkedAt.slice(0, 10))}.` : "Couldn’t update.";
    else if (saved?.checkedAt && Date.now() - Date.parse(saved.checkedAt) > 36 * 60 * 60 * 1000) caption = `Checked ${shortDate(saved.checkedAt.slice(0, 10))}`;
  } else if (visibleReceipts.length) {
    caption = checking ? "Checking your mailbox" : failed ? "Couldn’t check your mailbox. From your saved receipts." : "From your saved receipts";
  }
  return {
    insights: checked ? visibleNotice : visibleReceipts,
    origin: checked ? "notice" : "receipts",
    caption,
    canRetry: failed,
    retry: notice?.retry ?? (() => undefined),
  };
}

/**
 * A cancellation stays pending until the provider's own cancellation arrives after the choice: a saved receipt
 * for plans read from receipts, the provider's cancellation email for plans One's mailbox check found.
 * Nothing else, not the choice itself, counts as confirmation or as savings.
 */
export function useCancellationConfirmation(rows: readonly RecentReceiptRow[]): void {
  const tracking = useReceiptTracking();
  const doc = tracking?.doc ?? null;
  const apply = tracking?.apply;
  useEffect(() => {
    if (!doc || !apply) return;
    for (const pending of pendingCancellations(doc)) {
      const domain = pending.plan.key.includes(".") ? pending.plan.key.slice(0, pending.plan.key.lastIndexOf("|")) : null;
      const proofRef = domain
        ? providerCancellationFor(doc.notice, domain, pending.requestedAt)?.evidenceId
        : findCancellationProof(rows, pending.plan.key, pending.requestedAt)?.primaryReceiptKey;
      if (proofRef) void apply((current, ctx) => confirmCancellation(current, pending.insightId, pending.plan.key, proofRef, ctx));
    }
  }, [doc, apply, rows]);
}

export function InsightCard({
  insight, total, onSeeAll, onReview, waitingNote, caption, onTryAgain,
}: {
  insight: ReceiptInsight | null;
  total: number;
  onSeeAll: () => void;
  onReview: (insight: ReceiptInsight) => void;
  /** Shown when nothing new was noticed but a cancellation still awaits its provider. */
  waitingNote?: { title: string; detail: string } | null;
  /** How current this is, only when it isn't fresh. */
  caption?: string | null;
  onTryAgain?: (() => void) | null;
}) {
  const [source, setSource] = useState<NoticeEvidence | null>(null);
  // One email says it all for these: the provider's own notice, promise or announcement. Others list theirs in the sheet.
  const linked = insight?.notice?.evidence.find((item) => ["provider_notice", "refund_promise", "announcement"].includes(item.role)) ?? null;
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
        {/* The whole text area opens the evidence; the button beside it is the same action for the keyboard. */}
        <div className={cn("min-w-0", insight && "cursor-pointer")} onClick={insight ? () => onReview(insight) : undefined} data-testid="insight-card-body">
          <h3 className={cn(styles.cardTitle, "text-foreground")}>{insight?.title ?? waitingNote?.title}</h3>
          <p className="mt-1 text-[14px] leading-[21px] text-muted-foreground">{insight?.reason ?? waitingNote?.detail}</p>
          {linked ? (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); setSource(linked); }}
              className="-mb-1 mt-0.5 inline-flex min-h-11 items-center text-[14px] font-medium text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
            >
              View email
            </button>
          ) : null}
          {caption ? (
            <p className="mt-1.5 text-[12px] leading-[18px] text-muted-foreground" data-testid="insight-caption" role="status">
              {caption}
              {onTryAgain ? <>{" "}<button type="button" onClick={(event) => { event.stopPropagation(); onTryAgain(); }} className="font-medium text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]">Try again</button></> : null}
            </p>
          ) : null}
        </div>
        {insight ? (
          <button type="button" onClick={() => onReview(insight)} className={cn(styles.primaryPill, "shrink-0")}>
            {insight.action.label}
          </button>
        ) : null}
      </div>
      <NoticeSourceSheet target={source} onClose={() => setSource(null)} />
    </section>
  );
}

export function InsightsSheet({
  open, onOpenChange, insights, onReview, caption, onTryAgain,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  insights: readonly ReceiptInsight[];
  onReview: (insight: ReceiptInsight) => void;
  caption?: string | null;
  onTryAgain?: (() => void) | null;
}) {
  const doc = useReceiptTracking()?.doc ?? null;
  const [source, setSource] = useState<NoticeEvidence | null>(null);
  const savings = Object.entries(doc ? confirmedSavings(doc) : {}).filter(([, minor]) => minor > 0);
  const waiting = doc ? pendingCancellations(doc) : [];
  const settled = doc?.notice.resolved ?? [];
  return (
    <>
      <AdaptiveDetailSurface
        open={open}
        onOpenChange={onOpenChange}
        title="What One noticed"
        description="Each item shows the emails behind it. Nothing is cancelled or paid for you."
        surfaceClassName={`${mailStyles.typography} ${mailStyles.portal}`}
        mobilePresentation="sheet"
        desktopMaxWidthClassName="sm:!max-w-[520px]"
      >
        <div className="space-y-3" data-testid="insights-list">
          {caption ? (
            <p className="text-[12px] leading-[18px] text-muted-foreground" role="status">
              {caption}
              {onTryAgain ? <>{" "}<button type="button" onClick={onTryAgain} className="font-medium text-[color:var(--app-accent)]">Try again</button></> : null}
            </p>
          ) : null}
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
          )) : <p className="text-[14px] leading-[21px] text-muted-foreground" role="status">Nothing needs a look. One checks again when your mail changes.</p>}
          {settled.length ? (
            <div className="space-y-2 pt-1" data-testid="insights-settled">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Settled</p>
              {settled.slice(0, 5).map((item) => (
                <div key={item.priorId} className="rounded-2xl border border-[color:var(--app-card-border-standard)] px-4 py-3">
                  <p className="text-[14px] leading-[21px] text-foreground">{item.headline}</p>
                  <p className="text-[12px] leading-[18px] text-muted-foreground">{item.evidence.from} wrote on {shortDate(item.evidence.on)}: “{item.evidence.quote}”</p>
                  <button type="button" onClick={() => setSource(item.evidence)} className="min-h-11 text-[14px] font-medium text-[color:var(--app-accent)]">View email</button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </AdaptiveDetailSurface>
      <NoticeSourceSheet target={source} onClose={() => setSource(null)} />
    </>
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
  return insight?.notice
    ? <NoticeInsightReview key={insight.id} insight={insight} onClose={onClose} />
    : <ReceiptsInsightReview insight={insight} onClose={onClose} rows={rows} onOpenReceipt={onOpenReceipt} />;
}

/** The answer to "why is One showing me this": the finding, the emails behind it, and what the owner can do. */
function NoticeInsightReview({ insight, onClose }: { insight: ReceiptInsight; onClose: () => void }) {
  const tracking = useReceiptTracking();
  const finding = insight.notice!;
  const [source, setSource] = useState<NoticeEvidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const saved = useMemo(() => tracking?.doc?.reviews.find((review) => review.insightId === finding.id) ?? null, [tracking?.doc?.reviews, finding.id]);
  const [choices, setChoices] = useState<Record<string, "keep" | "cancel">>(saved?.choices ?? {});
  const canSave = tracking?.status === "ready";
  const caveat = noticeCaveat(finding);
  const single = finding.kind === "inactive_plan";
  const planChoices = finding.kind === "plan_review";

  const planKey = (domain: string) => noticePlanKey({ domain, currency: String(finding.facts.currency ?? "") });
  const wholePlan = () => {
    const currency = String(finding.facts.currency ?? "");
    const amount = typeof finding.facts.amount_minor === "number" ? finding.facts.amount_minor : null;
    return { key: planKey(finding.provider?.domain ?? ""), label: finding.provider?.name ?? "This plan", monthlyMinor: finding.facts.period === "monthly" ? amount : null, currency };
  };

  const answer = async (choice: "keep" | "not_an_issue") => {
    if (!tracking) return;
    setBusy(true);
    const ok = await tracking.apply((doc, ctx) => recordInsightReviewed(doc, finding.id, finding.headline, ctx, choice));
    setBusy(false);
    if (ok) onClose(); else setMessage(tracking.saveError);
  };
  const cancelWhole = async () => {
    if (!tracking) return;
    const plan = wholePlan();
    setBusy(true);
    const ok = await tracking.apply((doc, ctx) => savePlanReview(doc, { insightId: finding.id, reason: finding.reason, plans: [plan], choices: { [plan.key]: "cancel" } }, ctx));
    setBusy(false);
    setMessage(ok ? `Saved. One doesn’t cancel anything: cancel with ${plan.label}. Savings count once they confirm.` : tracking.saveError);
  };
  const savePlans = async () => {
    if (!tracking) return;
    setBusy(true);
    const plans = finding.plans.map((plan) => ({ key: planKey(plan.domain), label: plan.label, monthlyMinor: plan.period === "monthly" ? plan.amountMinor : null, currency: plan.currency }));
    const full = Object.fromEntries(finding.plans.map((plan) => [planKey(plan.domain), choices[planKey(plan.domain)] ?? "keep"] as const));
    const ok = await tracking.apply((doc, ctx) => savePlanReview(doc, { insightId: finding.id, reason: finding.reason, plans, choices: full }, ctx));
    setBusy(false);
    setMessage(ok ? "Saved. One doesn’t cancel anything: cancel with each provider. Savings count once they confirm." : tracking.saveError);
  };
  const status = (domain: string): string | null => {
    const choice = saved?.choices[planKey(domain)];
    if (!choice) return null;
    return choice === "keep" ? "Keeping" : saved?.confirmed[planKey(domain)] ? "Cancelled · confirmed" : "Marked to cancel · waiting for them to confirm";
  };

  return (
    <>
      <AdaptiveDetailSurface
        open
        onOpenChange={(open) => { if (!open) onClose(); }}
        eyebrow="One noticed"
        headerTextOverflow="wrap"
        title={finding.headline}
        description={finding.reason}
        surfaceClassName={`${mailStyles.typography} ${mailStyles.portal}`}
        mobilePresentation="sheet"
        desktopMaxWidthClassName="sm:!max-w-[520px]"
        footer={(
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
            {single ? (
              <>
                <button type="button" onClick={() => void cancelWhole()} disabled={busy || !canSave} className={styles.secondaryPill}>I want to cancel</button>
                <button type="button" onClick={() => void answer("keep")} disabled={busy || !canSave} className={styles.primaryPill}>Keep it</button>
              </>
            ) : planChoices ? (
              <>
                <button type="button" onClick={onClose} disabled={busy} className={styles.secondaryPill}>Not now</button>
                <button type="button" onClick={() => void savePlans()} disabled={busy || !canSave} className={styles.primaryPill}>Save choices</button>
              </>
            ) : (
              <button type="button" onClick={() => void answer("not_an_issue")} disabled={busy || !canSave} className={styles.secondaryPill}>Not an issue</button>
            )}
          </div>
        )}
      >
        <div className="space-y-4" data-testid="insight-review">
          <p className="text-[13px] font-semibold text-foreground">Why you’re seeing this</p>
          <NoticeFacts finding={finding} />
          {planChoices ? (
            <ul className="divide-y divide-border/60 rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]" data-testid="insight-plans">
              {finding.plans.map((plan) => {
                const choice = choices[planKey(plan.domain)] ?? "keep";
                const label = status(plan.domain);
                const evidence: NoticeEvidence = { evidenceId: plan.evidenceId, openKey: plan.openKey, role: "paid", quote: `${plan.label} · ${formatMinor(plan.amountMinor, plan.currency)}`, on: plan.paidOn, subject: plan.label, from: plan.label, domain: plan.domain };
                return (
                  <li key={plan.domain} className="space-y-2 px-4 py-3" data-testid="insight-plan">
                    <div className="flex items-center justify-between gap-3">
                      <button type="button" onClick={() => setSource(evidence)} className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]">
                        <span className="block truncate text-[14px] leading-[21px] font-semibold text-foreground">{plan.label}</span>
                        <span className="block text-[12px] leading-[18px] text-muted-foreground">{formatMinor(plan.amountMinor, plan.currency)}{plan.period === "monthly" ? " a month" : plan.period === "yearly" ? " a year" : ""} · View email</span>
                      </button>
                      <div role="radiogroup" aria-label={`${plan.label}: keep or cancel`} className="flex shrink-0 overflow-hidden rounded-full border border-[color:var(--app-card-border-standard)]">
                        {(["keep", "cancel"] as const).map((option) => (
                          <button
                            key={option}
                            type="button"
                            role="radio"
                            aria-checked={choice === option}
                            onClick={() => setChoices((previous) => ({ ...previous, [planKey(plan.domain)]: option }))}
                            className={cn("min-h-11 min-w-[68px] px-3 text-[13px] font-semibold capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent-ring)]", choice === option ? (option === "cancel" ? "bg-[color:var(--app-destructive-tint)] text-[color:var(--app-destructive-deep)]" : "bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)]") : "text-muted-foreground")}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>
                    {label ? <p className="text-[12px] leading-[18px] text-muted-foreground" role="status">{label}</p> : null}
                  </li>
                );
              })}
            </ul>
          ) : <EvidenceList evidence={finding.evidence} onOpen={setSource} />}
          {caveat ? <p className="text-[12px] leading-[18px] text-muted-foreground">{caveat}</p> : null}
          {single && saved ? <p className="text-[12px] leading-[18px] text-muted-foreground" role="status">{status(finding.provider?.domain ?? "") ?? ""}</p> : null}
          {message ? <p className="text-[13px] leading-[19px] text-muted-foreground" role="status">{message}</p> : null}
        </div>
      </AdaptiveDetailSurface>
      <NoticeSourceSheet target={source} onClose={() => setSource(null)} />
    </>
  );
}

/** Findings read from the saved receipts alone (no mailbox check behind them). */
function ReceiptsInsightReview({
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
