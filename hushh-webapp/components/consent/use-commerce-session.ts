"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

/** A read or action may settle only in the account, view and vault session that began it. */
export function useCommerceSession(scope: string) {
  const { user } = useAuth();
  const identity = useRef({ user, scope, generation: 0 });
  const mounted = useRef(true);
  useLayoutEffect(() => {
    identity.current = { user, scope, generation: identity.current.generation + 1 };
    mounted.current = true;
    return () => { mounted.current = false; identity.current.generation += 1; };
  }, [user, scope]);
  const capture = useCallback((includeVault = true) => {
    const { user: capturedUser, scope: capturedScope, generation } = identity.current;
    const epoch = snapshotVaultSessionEpoch();
    return () => mounted.current && identity.current.user === capturedUser &&
      identity.current.scope === capturedScope && identity.current.generation === generation &&
      (!includeVault || isVaultSessionEpochCurrent(epoch));
  }, []);
  return { user, capture };
}

/** Financial reads stay memory-only; newest response wins and visible pending work polls at 15s. */
export function useCommerceRead<T>(scope: string, load: (token: string) => Promise<T>, shouldPoll: (value: T) => boolean) {
  const { user, capture } = useCommerceSession(scope);
  const [result, setResult] = useState<{ value: T; user: typeof user; scope: string } | null>(null);
  const data = result && result.user === user && result.scope === scope ? result.value : null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!user) return;
    const current = capture();
    const currentView = capture(false);
    const read = ++sequence.current;
    const latest = () => current() && sequence.current === read;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      if (!latest()) return;
      const result = await load(token);
      if (latest()) { setResult({ value: result, user, scope }); setError(null); }
    } catch {
      if (latest()) setError("Payment status could not be checked. Refresh before continuing.");
    } finally { if (currentView() && sequence.current === read) setLoading(false); }
  }, [user, scope, load, capture]);
  useEffect(() => {
    setResult(null); setError(null); setLoading(false);
    void refresh();
    const onFocus = () => void refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      sequence.current += 1;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, scope]);
  usePeriodicTask(`commerce:${scope}:${user?.uid || "signed-out"}`, 15_000, () => refresh(), {
    enabled: Boolean(user && data && shouldPoll(data) && !loading),
  });
  return { user, data, refresh, loading, error, capture };
}
