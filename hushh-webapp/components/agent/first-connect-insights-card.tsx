"use client";

// "Here's what I picked up": One's first look at a source the person just
// connected, offered once per source. It is a review card, not a message:
// nothing on it is in memory until the person taps Keep on an item, and
// Forget simply drops the item from the screen. The items live only in this
// component's state (never browser storage); leaving the chat discards them.

import { useEffect, useRef, useState } from "react";

import { Check, Lightbulb, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import {
  fetchFirstConnectInsights,
  keepFirstConnectInsight,
  type FirstConnectInsight,
  type FirstConnectInsightsOffer,
} from "@/lib/agent/first-connect-insights";

type ItemState = "open" | "saving" | "kept" | "confirm_sharing" | "error" | "already_saved" | "nothing_to_save";

export type FirstConnectInsightsCardProps = {
  ownerId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  /** The chat is unlocked and ready; the card never asks before this. */
  enabled: boolean;
};

export function FirstConnectInsightsCard({
  ownerId,
  vaultKey,
  vaultOwnerToken,
  enabled,
}: FirstConnectInsightsCardProps) {
  const [offer, setOffer] = useState<FirstConnectInsightsOffer | null>(null);
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const [forgotten, setForgotten] = useState<ReadonlySet<string>>(new Set());
  const [recipients, setRecipients] = useState<Record<string, number>>({});
  const askedForOwnerRef = useRef<string | null>(null);
  const [offerOwner, setOfferOwner] = useState<{ ownerId: string; vaultKey: string; vaultOwnerToken: string } | null>(null);
  const credentialsRef = useRef({ ownerId, vaultKey, vaultOwnerToken, enabled });
  useEffect(() => { credentialsRef.current = { ownerId, vaultKey, vaultOwnerToken, enabled }; },
    [ownerId, vaultKey, vaultOwnerToken, enabled]);
  const sharingReviews = useRef(new Map<string, AgentPkmPreviewCard[]>());
  const saves = useRef(new Set<AbortController>());
  useEffect(() => {
    const controllers = saves.current;
    const reviews = sharingReviews.current;
    return () => { for (const controller of controllers) controller.abort(); controllers.clear(); reviews.clear(); };
  }, [enabled, ownerId, vaultKey, vaultOwnerToken]);

  // Ask once per owner per mount. The server offers each source at most once.
  useEffect(() => {
    if (!enabled || !ownerId || !vaultKey || !vaultOwnerToken) return undefined;
    if (askedForOwnerRef.current === ownerId) return undefined;
    askedForOwnerRef.current = ownerId;
    const controller = new AbortController();
    void fetchFirstConnectInsights({ vaultOwnerToken, vaultKey, signal: controller.signal }).then(
      (next) => {
        const current = credentialsRef.current;
        if (controller.signal.aborted || !current.enabled || current.ownerId !== ownerId ||
          current.vaultKey !== vaultKey || current.vaultOwnerToken !== vaultOwnerToken) return;
        setOfferOwner({ ownerId, vaultKey, vaultOwnerToken });
        setOffer(next);
        setStates({});
        setForgotten(new Set());
      },
    );
    return () => controller.abort();
  }, [enabled, ownerId, vaultKey, vaultOwnerToken]);

  // A different person, or a locked vault, never sees the previous card.
  useEffect(() => {
    setOffer(null);
  }, [enabled, ownerId, vaultKey, vaultOwnerToken]);

  if (!offer || !ownerId || !enabled || !vaultKey || !vaultOwnerToken ||
    offerOwner?.ownerId !== ownerId || offerOwner.vaultKey !== vaultKey ||
    offerOwner.vaultOwnerToken !== vaultOwnerToken) return null;
  const visible = offer.items.filter((item) => !forgotten.has(item.id));
  const isSaved = (item: FirstConnectInsight) => states[item.id] === "kept" || states[item.id] === "already_saved";
  const kept = visible.filter(isSaved).length;
  const saving = Object.values(states).includes("saving");
  const open = visible.filter((item) => !isSaved(item));

  const keep = async (item: FirstConnectInsight, sharingImpactAcknowledged = false) => {
    const { ownerId: userId, vaultKey: key, vaultOwnerToken: token } = credentialsRef.current;
    if (!userId || !key || !token || saves.current.size > 0) return;
    setStates((current) => ({ ...current, [item.id]: "saving" }));
    const controller = new AbortController();
    saves.current.add(controller);
    const guard = createAgentPkmCaptureGuard({
      userId,
      signal: controller.signal,
      isEnabled: () => credentialsRef.current.enabled && credentialsRef.current.ownerId === userId &&
        credentialsRef.current.vaultKey === key && credentialsRef.current.vaultOwnerToken === token,
    });
    try {
      if (!guard.isCurrent()) return;
      const result = await keepFirstConnectInsight({
        userId,
        vaultKey: key,
        vaultOwnerToken: token,
        memoryText: item.memoryText,
        sharingImpactAcknowledged,
        reviewedCards: sharingImpactAcknowledged ? sharingReviews.current.get(item.id) : undefined,
        isCurrent: guard.isCurrent,
        assertCurrent: guard.assertCurrent,
      });
      if (!guard.isCurrent()) return;
      if (result.status === "needs_sharing_ack") {
        sharingReviews.current.set(item.id, result.reviewedCards);
        setRecipients((current) => ({ ...current, [item.id]: result.recipientCount }));
      } else {
        sharingReviews.current.delete(item.id);
      }
      setStates((current) => ({
        ...current,
        [item.id]:
          result.status === "saved"
            ? "kept"
            : result.status === "already_saved"
              ? "already_saved"
              : result.status === "nothing_to_save"
                ? "nothing_to_save"
                : result.status === "needs_sharing_ack"
                  ? "confirm_sharing"
                  : "error",
      }));
    } finally {
      saves.current.delete(controller);
    }
  };

  const forget = (item: FirstConnectInsight) => {
    sharingReviews.current.delete(item.id);
    setForgotten((current) => new Set([...current, item.id]));
  };

  if (open.length === 0) {
    if (kept === 0) return null;
    return (
      <p
        className="px-1 text-xs text-foreground/60"
        data-testid="first-connect-insights-receipt"
        role="status"
      >
        {kept} {kept === 1 ? "detail" : "details"} from {offer.sourceLabel} {kept === 1 ? "is" : "are"} in your private
        memory. Nothing else was saved.
      </p>
    );
  }

  return (
    <section
      aria-label="What One picked up"
      className="rounded-2xl border border-primary/25 bg-primary/5 p-4"
      data-testid="first-connect-insights-card"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <Lightbulb className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            Here&apos;s what I picked up from {offer.sourceLabel}
          </p>
          <p className="mt-1 text-sm text-foreground/70">
            Nothing is saved unless you tap Keep.
          </p>
        </div>
      </div>
      <ul className="mt-3 space-y-2">
        {visible.map((item) => {
          const state = states[item.id] ?? "open";
          const busy = state === "saving";
          return (
            <li
              key={item.id}
              className="rounded-xl border border-black/10 bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.04]"
              data-testid="first-connect-insight"
            >
              <p className="text-sm text-foreground/90">{item.label}</p>
              {item.evidence ? (
                <p className="mt-1 text-xs text-foreground/55">{item.evidence}</p>
              ) : null}
              {isSaved(item) ? (
                <p className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  {state === "already_saved" ? "Already in Memory" : "Kept privately"}
                </p>
              ) : (
                <>
                  {state === "confirm_sharing" ? (
                    <p className="mt-2 text-xs text-foreground/70">
                      This would also update what you share with {recipients[item.id] ?? 1}{" "}
                      {(recipients[item.id] ?? 1) === 1 ? "person" : "people"}. Keep it anyway?
                    </p>
                  ) : null}
                  {state === "nothing_to_save" ? (
                    <p className="mt-2 text-xs text-foreground/70" role="status">
                      No new detail to save. Nothing was changed.
                    </p>
                  ) : null}
                  {state === "error" ? (
                    <p className="mt-2 text-xs text-destructive" role="alert">
                      Saving couldn&apos;t finish. Check Memory before trying again.
                    </p>
                  ) : null}
                  <div className="mt-3 grid grid-cols-2 items-stretch gap-2">
                    <Button
                      size="compact"
                      className="h-auto min-h-11 w-full min-w-0 whitespace-normal"
                      disabled={saving}
                      isLoading={busy}
                      onClick={() => void keep(item, state === "confirm_sharing")}
                      data-testid="first-connect-insight-keep"
                    >
                      <span className="inline-flex min-w-0 max-w-full items-center justify-center gap-1.5">
                        <Check className="size-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 whitespace-normal">{state === "confirm_sharing" ? "Keep and share" : "Keep"}</span>
                      </span>
                    </Button>
                    <Button
                      size="compact"
                      className="h-auto min-h-11 w-full min-w-0 whitespace-normal"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => forget(item)}
                      data-testid="first-connect-insight-forget"
                    >
                      <span className="inline-flex min-w-0 max-w-full items-center justify-center gap-1.5">
                        <X className="size-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 whitespace-normal">Forget</span>
                      </span>
                    </Button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
