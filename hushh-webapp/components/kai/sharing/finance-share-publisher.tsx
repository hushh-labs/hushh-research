"use client";

import { useEffect } from "react";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { projectAdvisorFinance, projectFinance } from "@/lib/finance-sharing/contract";
import { readSavedFinance } from "@/lib/finance-sharing/saved-source";
import { FinanceSharingService, clearPendingFinanceShares } from "@/lib/services/finance-sharing-service";
import { setFinancePublicationState, clearFinancePublication } from "@/lib/finance-sharing/publication-state";

/** Foreground-only publisher. No prices, provider credentials or model calls. */
export function FinanceSharePublisher() {
  const { capture, session, ready } = useFinanceShareContext();
  useEffect(() => {
    if (!ready) return;
    const ownerId = capture()?.userId;
    let retired = false, running = false, requested = false, sourceEpoch = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = async () => {
      if (retired || running || document.hidden) return;
      const owner = capture(); if (!owner) return;
      const epoch = sourceEpoch;
      const context = { ...owner, isCurrent: () => !retired && !document.hidden && epoch === sourceEpoch && owner.isCurrent() };
      running = true; requested = false;
      try {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await FinanceSharingService.history(context, "outgoing", cursor);
          for (const metadata of page.items) {
            if (!context.isCurrent()) return;
            if (metadata.status !== "active" || metadata.policy.mode !== "ongoing") continue;
            try {
              const grant = await FinanceSharingService.view(context, metadata.id);
              const config = await FinanceSharingService.ownerConfig(context, grant);
              const advisor = grant.policy.version === 2;
              const saved = await readSavedFinance(context, config.source, advisor);
              // New/missing accounts require a new approval; never substitute current UI source.
              if (!context.isCurrent()) return;
              if (saved.sourceFence !== config.sourceFence) { setFinancePublicationState(context.userId, grant.id, "source_changed"); continue; }
              await FinanceSharingService.refresh(context, grant, advisor
                ? projectAdvisorFinance(saved.model, saved.portfolio, config.source)
                : projectFinance(saved.model, config.selection, config.source));
              if (context.isCurrent()) setFinancePublicationState(context.userId, grant.id, "current");
            } catch {
              // Key rotation, absent source and revision races keep the last approved view.
              // The recipient's independent authority check still denies ended access.
              if (!context.isCurrent()) return;
              setFinancePublicationState(context.userId, metadata.id, "unavailable");
            }
          }
          cursor = page.nextCursor ?? undefined;
          if (cursor && seen.has(cursor)) return;
          if (cursor) seen.add(cursor);
        } while (cursor && context.isCurrent());
      } catch {
        // An unavailable authority never authorizes an update. Retry at the next
        // saved change, foreground transition or explicit sharing change.
      } finally {
        running = false;
        if (!retired && requested && !document.hidden) timer = setTimeout(() => void publish(), 250);
      }
    };
    const queue = () => { requested = true; if (!running) { clearTimeout(timer); timer = setTimeout(() => void publish(), 250); } };
    const unsubscribe = subscribeToPkmDomainChanges(detail => {
      const owner = capture();
      if (detail.domain !== "financial" || detail.userId !== owner?.userId) return;
      sourceEpoch++; queue();
    });
    const foreground = () => { sourceEpoch++; if (!document.hidden) queue(); };
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("finance-sharing-changed", queue);
    queue();
    return () => { retired = true; sourceEpoch++; if (ownerId) { clearPendingFinanceShares(ownerId); clearFinancePublication(ownerId); } clearTimeout(timer); unsubscribe(); document.removeEventListener("visibilitychange", foreground); window.removeEventListener("finance-sharing-changed", queue); };
  }, [capture, ready, session]);
  return null;
}
