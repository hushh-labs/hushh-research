"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClock, ChevronDown, Inbox, X } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button, morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { formatCents } from "@/lib/services/slice-pricing-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { applySlicePosture } from "@/lib/personal-knowledge-model/slice-publishing";
import {
  OneOpportunityService,
  type OpportunitySignal,
} from "@/lib/one-marketplace/opportunity-service";
import {
  OneMarketplaceService,
  type MarketplaceRequest,
} from "@/lib/one-marketplace/service";

/** Honest posture until a payment rail exists: approving grants access, not money. */
function PaymentsComingSoonChip() {
  return (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      Payments coming soon
    </span>
  );
}

/**
 * Proactive Information Marketplace flashcards on Agent One. Unlike the derived-
 * fresh nudges elsewhere (Gmail, Location), these are durable signals (migration
 * 077) with a persisted lifecycle: "Remind me later" snoozes to tomorrow, Dismiss
 * hides for good, and "Publish for offers" runs the real consent-first posture
 * flow then records the signal as published — all surviving reloads and days.
 *
 * The whole loop the Information Marketplace promises starts here: open Agent One
 * → a card greets you → publish → buyers can reach you.
 */

function relativeDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const days = Math.round((then - Date.now()) / 86_400_000);
  if (days <= 0) return "soon";
  if (days === 1) return "tomorrow";
  if (days < 30) return `in ${days} days`;
  const months = Math.round(days / 30);
  return months === 1 ? "in a month" : `in ${months} months`;
}

function OpportunityNudgeCard({
  signal,
  busy,
  onPublish,
  onSnooze,
  onDismiss,
}: {
  signal: OpportunitySignal;
  busy: boolean;
  onPublish: (signal: OpportunitySignal) => void;
  onSnooze: (signal: OpportunitySignal) => void;
  onDismiss: (signal: OpportunitySignal) => void;
}) {
  const isExpiry = signal.kind === "expiry";
  const when = isExpiry ? relativeDay(signal.eventDate) : null;
  const price = signal.suggestedPriceCents
    ? formatCents(signal.suggestedPriceCents, signal.currency ?? "USD")
    : null;

  return (
    <div className="rounded-2xl border border-emerald-300/50 bg-emerald-50/50 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/15">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-emerald-900 dark:text-emerald-200">
        {isExpiry ? <CalendarClock className="h-4 w-4 shrink-0" aria-hidden /> : null}
        <span className="min-w-0">{signal.title}</span>
      </div>
      {signal.body ? (
        <p className="mb-2 text-xs text-emerald-900/80 dark:text-emerald-200/70">{signal.body}</p>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {signal.metadata?.domainTitle ?? signal.domain}
        </span>
        {when ? <span>· {when}</span> : null}
        {price ? <span>· ~{price}/mo</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="none"
          effect="fade"
          disabled={busy}
          onClick={() => onPublish(signal)}
        >
          {busy ? "Publishing…" : "Publish for offers"}
        </Button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onSnooze(signal)}
          className="text-xs font-medium text-emerald-700/80 hover:underline disabled:opacity-50 dark:text-emerald-300/80"
        >
          Remind me later
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDismiss(signal)}
          className="text-xs font-medium text-muted-foreground hover:underline disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * A real buyer asking to access a published slice (durable request, migration
 * 076). This is the demand half of the loop: publish → a buyer requests → the
 * owner approves here. Consent-first — approving grants scoped access to the safe
 * summary only, and NO money moves (payments are coming soon), so the card never
 * promises a payout.
 */
function BuyerRequestCard({
  request,
  busy,
  onApprove,
  onDecline,
}: {
  request: MarketplaceRequest;
  busy: boolean;
  onApprove: (request: MarketplaceRequest) => void;
  onDecline: (request: MarketplaceRequest) => void;
}) {
  const buyer = request.buyerLabel?.trim() || "A buyer";
  const price = request.priceCents
    ? formatCents(request.priceCents, request.currency ?? "USD")
    : null;

  return (
    <div className="rounded-2xl border border-sky-300/50 bg-sky-50/50 p-3 dark:border-sky-900/40 dark:bg-sky-950/15">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-sky-900 dark:text-sky-200">
        <Inbox className="h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0">{buyer} wants access</span>
      </div>
      <p className="mb-2 text-xs text-sky-900/80 dark:text-sky-200/70">
        {request.sliceName}
        {request.message ? <span className="italic"> — “{request.message}”</span> : null}
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {price ? <span>suggested ~{price}/mo</span> : null}
        <PaymentsComingSoonChip />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="none"
          effect="fade"
          disabled={busy}
          onClick={() => onApprove(request)}
        >
          {busy ? "Approving…" : "Approve access"}
        </Button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecline(request)}
          className="text-xs font-medium text-muted-foreground hover:underline disabled:opacity-50"
        >
          Decline
        </button>
      </div>
    </div>
  );
}

/**
 * On-open stack of due opportunity signals plus pending buyer requests.
 * Self-fetching (like GmailNudgesSection) so the workspace only has to render it;
 * renders nothing until there is at least one buyer request or due signal.
 * Vault-token gated — no Firebase id-token.
 *
 * Order: buyer requests first (real demand to act on), then publish
 * opportunities (things to put up for offers).
 */
export function OpportunityNudgeStack({
  userId,
  vaultOwnerToken,
  vaultKey,
  onRequireUnlock,
  variant = "stack",
  dismissed = false,
  onDismissPanel,
  signals: externalSignals,
  requests: externalRequests,
  loading = false,
  onRefresh,
}: {
  userId: string | null;
  vaultOwnerToken: string | null;
  vaultKey: string | null;
  /** Just-in-time vault unlock when a publish is requested while the vault is locked. */
  onRequireUnlock: () => void;
  variant?: "stack" | "accordion";
  /** Chat-surface-only dismissal. Does not mutate opportunity records. */
  dismissed?: boolean;
  onDismissPanel?: () => void;
  /** Optional preloaded workspace data. When provided, this component skips its internal fetch. */
  signals?: OpportunitySignal[];
  requests?: MarketplaceRequest[];
  loading?: boolean;
  onRefresh?: () => void;
}) {
  const [signals, setSignals] = useState<OpportunitySignal[]>([]);
  const [requests, setRequests] = useState<MarketplaceRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const loadKeyRef = useRef<string | null>(null);
  const usesExternalData = Boolean(externalSignals || externalRequests);
  const visibleSignals = externalSignals ?? signals;
  const visibleRequests = externalRequests ?? requests;

  const canLoad = Boolean(userId && vaultOwnerToken && !dismissed && !usesExternalData);

  const load = useCallback(async () => {
    if (!vaultOwnerToken) return;
    // Fetch both halves independently so one failing doesn't blank the other.
    const [dueResult, requestResult] = await Promise.allSettled([
      OneOpportunityService.listDue({ vaultOwnerToken }),
      OneMarketplaceService.listRequests({ vaultOwnerToken, status: "pending" }),
    ]);
    setSignals(
      dueResult.status === "fulfilled"
        ? dueResult.value.filter((s) => s.status === "active" || s.status === "snoozed")
        : [],
    );
    setRequests(
      requestResult.status === "fulfilled"
        ? requestResult.value.filter((r) => r.status === "pending")
        : [],
    );
  }, [vaultOwnerToken]);

  useEffect(() => {
    if (!canLoad || !userId || !vaultOwnerToken) return;
    const key = `${userId}:${vaultOwnerToken.slice(0, 12)}`;
    if (loadKeyRef.current === key) return;
    loadKeyRef.current = key;
    void load();
  }, [canLoad, userId, vaultOwnerToken, load]);

  // Optimistically drop a handled card, then refetch to reconcile with the server.
  const removeAndRefresh = useCallback(
    (signalId: string) => {
      setSignals((current) => current.filter((s) => s.id !== signalId));
      onRefresh?.();
      void load();
    },
    [load, onRefresh],
  );

  const removeRequestAndRefresh = useCallback(
    (requestId: string) => {
      setRequests((current) => current.filter((r) => r.id !== requestId));
      onRefresh?.();
      void load();
    },
    [load, onRefresh],
  );

  const handleApproveRequest = useCallback(
    async (request: MarketplaceRequest) => {
      if (!vaultOwnerToken) return;
      setBusyId(request.id);
      try {
        await OneMarketplaceService.approveRequest({ vaultOwnerToken, requestId: request.id });
        // Honest: access is granted, but no money moves yet.
        toast.success("Approved — buyer now has access. Payouts are coming soon.");
        removeRequestAndRefresh(request.id);
      } catch {
        toast.error("Couldn't approve this request.");
      } finally {
        setBusyId(null);
      }
    },
    [vaultOwnerToken, removeRequestAndRefresh],
  );

  const handleDeclineRequest = useCallback(
    async (request: MarketplaceRequest) => {
      if (!vaultOwnerToken) return;
      setBusyId(request.id);
      try {
        await OneMarketplaceService.denyRequest({ vaultOwnerToken, requestId: request.id });
        removeRequestAndRefresh(request.id);
      } catch {
        toast.error("Couldn't decline this request.");
      } finally {
        setBusyId(null);
      }
    },
    [vaultOwnerToken, removeRequestAndRefresh],
  );

  const handlePublish = useCallback(
    async (signal: OpportunitySignal) => {
      if (!userId || !vaultOwnerToken) return;
      if (!vaultKey) {
        // Vault locked — bounce to the just-in-time unlock; the card stays put so
        // the user can retry publishing once unlocked.
        onRequireUnlock();
        return;
      }
      const topLevelScopePath = signal.metadata?.topLevelScopePath;
      if (!topLevelScopePath) {
        toast.error("This opportunity can't be published automatically yet.");
        return;
      }
      setBusyId(signal.id);
      try {
        const previousManifest = await PersonalKnowledgeModelService.getDomainManifest(
          userId,
          signal.domain,
          vaultOwnerToken,
          true,
        );
        if (!previousManifest) {
          throw new Error("Couldn't load your data to publish this section.");
        }
        await applySlicePosture({
          userId,
          domain: signal.domain,
          domainTitle: signal.metadata?.domainTitle ?? signal.domain,
          permission: {
            scopeHandle: signal.scopeHandle ?? signal.metadata?.scopeHandle ?? null,
            label: signal.metadata?.label ?? signal.title,
            description: null,
            topLevelScopePath,
          },
          nextPosture: "default_available",
          previousManifest,
          vaultKey,
          vaultOwnerToken,
          source: "opportunity_nudge",
          // The card IS the owner's explicit consent to publish; forward it so the
          // backend can expose restricted-tier personal data (structural keys are
          // still hard-blocked server-side).
          ownerConsentOverride: true,
        });
        // Record the transition so this signal stops resurfacing. Best-effort —
        // the publish already succeeded, so don't fail the flow if this hiccups.
        await OneOpportunityService.markPublished({
          vaultOwnerToken,
          signalId: signal.id,
        }).catch(() => {});
        toast.success("Published — buyers can now reach you with offers.");
        removeAndRefresh(signal.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't publish this section.");
      } finally {
        setBusyId(null);
      }
    },
    [userId, vaultOwnerToken, vaultKey, onRequireUnlock, removeAndRefresh],
  );

  const handleSnooze = useCallback(
    async (signal: OpportunitySignal) => {
      if (!vaultOwnerToken) return;
      setBusyId(signal.id);
      try {
        await OneOpportunityService.snooze({ vaultOwnerToken, signalId: signal.id });
        toast.success("Reminder set — this will come back tomorrow.");
        removeAndRefresh(signal.id);
      } catch {
        toast.error("Couldn't snooze this reminder.");
      } finally {
        setBusyId(null);
      }
    },
    [vaultOwnerToken, removeAndRefresh],
  );

  const handleDismiss = useCallback(
    async (signal: OpportunitySignal) => {
      if (!vaultOwnerToken) return;
      setBusyId(signal.id);
      try {
        await OneOpportunityService.dismiss({ vaultOwnerToken, signalId: signal.id });
        removeAndRefresh(signal.id);
      } catch {
        toast.error("Couldn't dismiss this.");
      } finally {
        setBusyId(null);
      }
    },
    [vaultOwnerToken, removeAndRefresh],
  );

  if (dismissed) return null;

  const totalCount = visibleSignals.length + visibleRequests.length;
  if (!loading && totalCount === 0) return null;
  const cards = (
    <>
      {visibleRequests.map((request) => (
        <BuyerRequestCard
          key={request.id}
          request={request}
          busy={busyId === request.id}
          onApprove={handleApproveRequest}
          onDecline={handleDeclineRequest}
        />
      ))}
      {visibleSignals.map((signal) => (
        <OpportunityNudgeCard
          key={signal.id}
          signal={signal}
          busy={busyId === signal.id}
          onPublish={handlePublish}
          onSnooze={handleSnooze}
          onDismiss={handleDismiss}
        />
      ))}
    </>
  );

  if (variant === "accordion") {
    return (
      <Collapsible defaultOpen={false}>
        <div className="overflow-hidden rounded-xl border border-border/70 bg-background/65">
          <div className="flex items-center gap-1">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="group flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                <span className="min-w-0 truncate">Marketplace opportunities</span>
                <span className="inline-flex shrink-0 items-center gap-2">
                  <span className="rounded-full bg-accent-surface px-2 py-0.5 text-[10px] font-semibold text-accent-strong">
                    {totalCount}
                  </span>
                  <ChevronDown
                    className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180"
                    aria-hidden
                  />
                </span>
              </button>
            </CollapsibleTrigger>
            {onDismissPanel ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDismissPanel();
                }}
                className="mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                aria-label="Hide marketplace opportunities for this vault session"
                title="Hide for this vault session"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
          <CollapsibleContent>
            <div className="max-h-72 min-h-0 overflow-y-auto overscroll-contain border-t border-border/60">
              <div className="space-y-2 p-3">
                {loading && totalCount === 0 ? (
                  <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                    Loading marketplace opportunities...
                  </div>
                ) : (
                  cards
                )}
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
        Marketplace opportunities
      </p>
      {cards}
    </div>
  );
}
