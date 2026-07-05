"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClock, Sparkles } from "lucide-react";

import { Button, morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { formatCents } from "@/lib/services/slice-pricing-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { applySlicePosture } from "@/lib/personal-knowledge-model/slice-publishing";
import {
  OneOpportunityService,
  type OpportunitySignal,
} from "@/lib/one-marketplace/opportunity-service";

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
        {isExpiry ? (
          <CalendarClock className="h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <Sparkles className="h-4 w-4 shrink-0" aria-hidden />
        )}
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
 * On-open stack of due opportunity signals. Self-fetching (like GmailNudgesSection)
 * so the workspace only has to render it; renders nothing until there is at least
 * one due signal. Vault-token gated — no Firebase id-token.
 */
export function OpportunityNudgeStack({
  userId,
  vaultOwnerToken,
  vaultKey,
  onRequireUnlock,
}: {
  userId: string | null;
  vaultOwnerToken: string | null;
  vaultKey: string | null;
  /** Just-in-time vault unlock when a publish is requested while the vault is locked. */
  onRequireUnlock: () => void;
}) {
  const [signals, setSignals] = useState<OpportunitySignal[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const loadKeyRef = useRef<string | null>(null);

  const canLoad = Boolean(userId && vaultOwnerToken);

  const load = useCallback(async () => {
    if (!vaultOwnerToken) return;
    try {
      const due = await OneOpportunityService.listDue({ vaultOwnerToken });
      setSignals(due.filter((s) => s.status === "active" || s.status === "snoozed"));
    } catch {
      // A nudge fetch failing is non-fatal — just show nothing this open.
      setSignals([]);
    }
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
      void load();
    },
    [load],
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

  if (signals.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
        Marketplace opportunities
      </p>
      {signals.map((signal) => (
        <OpportunityNudgeCard
          key={signal.id}
          signal={signal}
          busy={busyId === signal.id}
          onPublish={handlePublish}
          onSnooze={handleSnooze}
          onDismiss={handleDismiss}
        />
      ))}
    </div>
  );
}
