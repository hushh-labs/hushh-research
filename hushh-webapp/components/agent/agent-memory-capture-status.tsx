"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import { AgentMemorySaveCard } from "@/components/agent/agent-memory-save-card";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/navigation/routes";
import {
  describeAgentPkmCapture,
  isAgentPkmCaptureRunning,
  type AgentPkmCaptureStatus,
} from "@/lib/agent/agent-pkm-capture-runtime";
import { useAuth } from "@/hooks/use-auth";
import { stageReservedOfferPrefill, type ReservedOfferItem } from "@/lib/pkm/reserved-offer";

/**
 * A receipt that offers to finish facts on the app screens that own them. The
 * prefill is staged in memory for that screen, then the app navigates on the
 * client: the route carries no detail of the fact.
 */
function MemorySaveCardWithOffers({
  receipt,
  onConfirmNeedsOwner,
  onRetry,
  pendingCards,
  canConfirmNeedsOwner,
}: {
  receipt: NonNullable<AgentPkmCaptureStatus["receipt"]>;
  onConfirmNeedsOwner?: (reviewedCards: readonly AgentPkmPreviewCard[]) => Promise<void>;
  onRetry?: () => Promise<void>;
  pendingCards?: readonly AgentPkmPreviewCard[];
  canConfirmNeedsOwner?: boolean;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const ownerUserId = user?.uid ?? null;
  const openOffer = useCallback((offer: ReservedOfferItem) => {
    if (ownerUserId && offer.prefill) {
      stageReservedOfferPrefill({ ownerUserId, ownerFeature: offer.ownerFeature, prefill: offer.prefill });
    }
    router.push(offer.routePattern);
  }, [ownerUserId, router]);
  return (
    <AgentMemorySaveCard
      receipt={receipt}
      memoryHref={ROUTES.PKM_RECENT}
      renderLink={({ href, className, children }) => (
        <Link href={href} className={className}>{children}</Link>
      )}
      onConfirmNeedsOwner={onConfirmNeedsOwner}
      onOpenOffer={openOffer}
      onRetry={onRetry}
      pendingCards={pendingCards}
      canConfirmNeedsOwner={canConfirmNeedsOwner}
    />
  );
}

/**
 * One quiet, session-only receipt next to the answer; never a second message.
 * An explicit save that finished shows its receipt card; everything else is
 * one status line that always resolves (see the capture job's deadline).
 */
export function AgentMemoryCaptureStatus({
  status,
  onConfirmNeedsOwner,
  onRetry,
  onUnlock,
  pendingCards,
  canConfirmNeedsOwner,
}: {
  status: AgentPkmCaptureStatus;
  onConfirmNeedsOwner?: (reviewedCards: readonly AgentPkmPreviewCard[]) => Promise<void>;
  /** Continue the save job behind this receipt (lines not yet saved). */
  onRetry?: () => Promise<void>;
  onUnlock?: () => void;
  pendingCards?: readonly AgentPkmPreviewCard[];
  canConfirmNeedsOwner?: boolean;
}) {
  if (status.phase === "skipped" && !status.receipt) return null;
  const running = isAgentPkmCaptureRunning(status);
  if (status.receipt && !running && status.phase !== "canceled" && status.receipt.offers?.length) {
    return (
      <MemorySaveCardWithOffers
        receipt={status.receipt}
        onConfirmNeedsOwner={onConfirmNeedsOwner}
        onRetry={onRetry}
        pendingCards={pendingCards}
        canConfirmNeedsOwner={canConfirmNeedsOwner}
      />
    );
  }
  if (status.receipt && !running && status.phase !== "canceled") {
    return (
      <AgentMemorySaveCard
        receipt={status.receipt}
        memoryHref={ROUTES.PKM_RECENT}
        renderLink={({ href, className, children }) => (
          <Link href={href} className={className}>{children}</Link>
        )}
        onConfirmNeedsOwner={onConfirmNeedsOwner}
        onRetry={onRetry}
        pendingCards={pendingCards}
        canConfirmNeedsOwner={canConfirmNeedsOwner}
      />
    );
  }
  return (
    <div
      className="flex min-h-11 flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
      data-testid="memory-capture-status"
    >
      <span role="status">{describeAgentPkmCapture(status)}</span>
      {status.phase === "needs_unlock" && onUnlock ? (
        <Button size="compact" variant="ghost" onClick={onUnlock}>
          Unlock vault
        </Button>
      ) : null}
      {!running && status.phase !== "needs_unlock" ? (
        <Link
          href={ROUTES.PKM_RECENT}
          className="inline-flex min-h-11 cursor-pointer items-center text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          View Memory
        </Link>
      ) : null}
    </div>
  );
}
