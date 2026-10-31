"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { peekLiveMirror } from "@/lib/pkm/memory-refresh";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { CacheService } from "@/lib/services/cache-service";
import type { LiveMirrorView } from "@/lib/pkm/live-mirror-contract";

export type LiveMirrorViewState =
  | { status: "locked"; view: null }
  | { status: "loading"; view: null }
  | { status: "ready"; view: LiveMirrorView };

/**
 * The one owner- and vault-epoch-fenced read of the shared Live Mirror. Every
 * surface that shows the mirror uses it, so a lock or account switch hides the
 * prior owner's view everywhere at once. Re-reads each second, on cache
 * changes and when the tab becomes visible, so read-time staleness shows even
 * after timers were throttled.
 */
export function useLiveMirrorView(active = true): LiveMirrorViewState {
  const { userId } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const [, setTick] = useState(0);
  const uid = userId;
  useEffect(() => {
    if (!active || !uid || !isVaultUnlocked) return;
    const rerender = () => setTick((tick) => tick + 1);
    const onVisibility = () => {
      if (document.visibilityState === "visible") rerender();
    };
    const stop = CacheService.getInstance().subscribe(rerender);
    const timer = window.setInterval(rerender, 1000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, uid, isVaultUnlocked, vaultOwnerToken]);
  if (!active || !uid || !isVaultUnlocked) return { status: "locked", view: null };
  const view = peekLiveMirror(uid);
  if (!view || view.ownerId !== uid || view.vaultEpoch !== snapshotVaultSessionEpoch())
    return { status: "loading", view: null };
  return { status: "ready", view };
}
