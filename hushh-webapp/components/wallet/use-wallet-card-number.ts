"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { WalletService, type WalletCardSummary } from "@/lib/services/wallet-service";
import type { CardShareContext } from "@/lib/services/wallet-card-share-service";

function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  const unsubscribe = subscribeNativePrivacyObservation(listener);
  return () => { document.removeEventListener("visibilitychange", listener); unsubscribe(); };
}
function visible() {
  const privacy = nativePrivacyObservation().state;
  return typeof document !== "undefined" && document.visibilityState !== "hidden" &&
    (!privacy || !privacy.shielded && privacy.appIsActive);
}

/** Selected owner card only. Keep the number out of collection caches and summaries. */
export function useWalletCardNumber({ card, active, scope, getContext }: {
  card: WalletCardSummary | null; active: boolean; scope: object;
  getContext: (cardId: string) => CardShareContext | null;
}) {
  const isVisible = useSyncExternalStore(subscribeVisibility, visible, () => false);
  const [retry, setRetry] = useState(0);
  const visit = useMemo(() => ({ card, active, scope, isVisible, retry }), [card, active, scope, isVisible, retry]);
  const [result, setResult] = useState<{ visit: typeof visit; pan: string | null } | null>(null);
  useEffect(() => {
    setResult(null);
    if (!card || !active || !isVisible) return;
    const context = getContext(card.cardId);
    if (!context?.isCurrent()) return;
    let cancelled = false;
    void (async () => {
      try {
        const pan = await WalletService.getCardNumber({ userId: context.userId, vaultKey: context.vaultKey,
          vaultOwnerToken: context.vaultOwnerToken, cardId: card.cardId });
        if (!cancelled && context.isCurrent()) setResult({ visit, pan: pan?.endsWith(card.last4) ? pan : null });
      } catch {
        if (!cancelled && context.isCurrent()) setResult({ visit, pan: null });
      }
    })();
    return () => { cancelled = true; };
  }, [visit, card, active, isVisible, getContext]);
  const current = active && isVisible && result?.visit === visit ? result : null;
  return { pan: current?.pan ?? null, failed: Boolean(current && !current.pan), retry: () => setRetry(value => value + 1) };
}
