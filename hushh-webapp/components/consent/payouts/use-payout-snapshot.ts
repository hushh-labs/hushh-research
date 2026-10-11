"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

export const PAYOUT_READY_SOURCE = "document_payout_ready";
export const PAYOUT_FALLBACK_POLL_MS = 45_000;
// Focus and visibilitychange both fire on one return to the tab.
const RESUME_REFRESH_GAP_MS = 1_000;

/** Coalesces live invalidations and fences every response to its vault session. */
export function usePayoutSnapshot<T>(load: (token: string) => Promise<T>, {
  active = true, refreshKey = "", bankOnly = false, refreshOnFeedChange = true, ignoreReadyEvent = false,
}: { active?: boolean; refreshKey?: string; bankOnly?: boolean; refreshOnFeedChange?: boolean; ignoreReadyEvent?: boolean } = {}) {
  const { vaultOwnerToken } = useVault();
  const scope = useMemo(() => ({ token: vaultOwnerToken, active }), [vaultOwnerToken, active]);
  const liveScope = useRef<typeof scope | null>(null);
  const [snapshot, setSnapshot] = useState<{ scope: typeof scope; value: T } | null>(null);
  const [error, setError] = useState<{ scope: typeof scope; cause: unknown } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    liveScope.current = scope;
    if (!active || !vaultOwnerToken) return;
    const epoch = snapshotVaultSessionEpoch();
    let cancelled = false;
    let pending = false;
    let queued = false;
    let resumedAt = -Infinity;
    const current = () => !cancelled && isVaultSessionEpochCurrent(epoch);
    const refresh = async () => {
      if (!current()) return;
      if (pending) { queued = true; return; }
      pending = true;
      try {
        const value = await load(vaultOwnerToken);
        if (current()) { setSnapshot({ scope, value }); setError(null); }
      } catch (cause) {
        if (current()) setError({ scope, cause });
      } finally {
        pending = false;
        if (queued && current()) { queued = false; void refresh(); }
      }
    };
    void refresh();
    // SSE is the fast path. A bounded visible-page read repairs a missed
    // notification while Payouts remains open, without polling in background.
    const poll = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, PAYOUT_FALLBACK_POLL_MS);
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string; requestId?: string }>).detail;
      if ((ignoreReadyEvent && detail?.source === PAYOUT_READY_SOURCE) || (bankOnly && detail?.requestId)) return;
      void refresh();
    };
    // One read per return to the tab. A read already in flight is fresh
    // enough, so a return never queues another behind it.
    const onResume = () => {
      if (document.hidden || pending || Date.now() - resumedAt < RESUME_REFRESH_GAP_MS) return;
      resumedAt = Date.now();
      void refresh();
    };
    if (refreshOnFeedChange) window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onChange);
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      cancelled = true;
      liveScope.current = null;
      window.clearInterval(poll);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, onChange);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [active, vaultOwnerToken, scope, load, refreshKey, retry, bankOnly, refreshOnFeedChange, ignoreReadyEvent]);
  const data = snapshot?.scope === scope ? snapshot.value : null;
  return { data, failed: error?.scope === scope, loading: data === null && error?.scope !== scope,
    error: error?.scope === scope ? error.cause : null,
    token: vaultOwnerToken, scope,
    isCurrent: () => liveScope.current === scope,
    retry: () => setRetry((value) => value + 1) };
}
