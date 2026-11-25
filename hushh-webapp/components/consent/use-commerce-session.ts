"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { usePathname, useSearchParams } from "next/navigation";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { resolveProfilePaneUrlState } from "@/lib/navigation/profile-pane";
import { ROUTES } from "@/lib/navigation/routes";
import { usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { snapshotAuthSessionGeneration, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";

/** Inactive retained Profile screens must not claim pane or underlying route Back. */
export function useCommerceAccountBackLayer(depth: number, back: () => boolean) {
  const pathname = usePathname();
  const pane = resolveProfilePaneUrlState(useSearchParams());
  const panel = pane.location.panel;
  const active = pane.open ? panel === "payouts" && !pane.location.detail :
    pathname === ROUTES.PROFILE_PAYOUTS;
  useBackLayer(pathname, active ? depth : 0, back, pane.open && active ? { profile_pane: "1", profile_panel: panel! } : undefined);
}

/** A read or action may settle only in the account, view and vault session that began it. */
export function useCommerceSession(scope: string, active = true) {
  const { user: authenticatedUser, userId: authenticatedUserId } = useAuth();
  const user = active ? authenticatedUser : null;
  const userId = active ? authenticatedUserId : null;
  const identity = useRef({ user, scope, active, generation: 0 });
  const mounted = useRef(true);
  useLayoutEffect(() => {
    identity.current = { user, scope, active, generation: identity.current.generation + 1 };
    mounted.current = true;
    return () => { mounted.current = false; identity.current.generation += 1; };
  }, [user, scope, active]);
  const capture = useCallback((includeVault = true) => {
    const { user: capturedUser, scope: capturedScope, generation } = identity.current;
    const epoch = snapshotVaultSessionEpoch();
    const authGeneration = snapshotAuthSessionGeneration();
    return () => mounted.current && identity.current.active && identity.current.user === capturedUser &&
      identity.current.scope === capturedScope && identity.current.generation === generation &&
      (!authGeneration || isValidatedAuthSessionOwnerCurrent(authGeneration)) &&
      (!includeVault || isVaultSessionEpochCurrent(epoch));
  }, []);
  return { user, userId, capture };
}

const WARM_COMMERCE_TTL_MS = 60_000;
const warmCommerceReads = new WeakMap<
  (token: string) => Promise<unknown>,
  Map<
    string,
    {
      value: unknown;
      vaultEpoch: number;
      authGeneration: ReturnType<typeof snapshotAuthSessionGeneration>;
      savedAt: number;
    }
  >
>();

function peekWarmCommerceRead<T>(
  load: (token: string) => Promise<T>,
  scope: string,
  userId: string | null,
): T | null {
  if (!userId) return null;
  const entry = warmCommerceReads.get(load as (token: string) => Promise<unknown>)?.get(`${scope}:${userId}`);
  if (!entry) return null;
  if (
    !isVaultSessionEpochCurrent(entry.vaultEpoch) ||
    (entry.authGeneration && !isValidatedAuthSessionOwnerCurrent(entry.authGeneration)) ||
    Date.now() - entry.savedAt > WARM_COMMERCE_TTL_MS
  ) {
    warmCommerceReads.get(load as (token: string) => Promise<unknown>)?.delete(`${scope}:${userId}`);
    return null;
  }
  return entry.value as T;
}

function storeWarmCommerceRead<T>(
  load: (token: string) => Promise<T>,
  scope: string,
  userId: string | null,
  value: T,
): void {
  if (!userId) return;
  const fnKey = load as (token: string) => Promise<unknown>;
  let bucket = warmCommerceReads.get(fnKey);
  if (!bucket) {
    bucket = new Map();
    warmCommerceReads.set(fnKey, bucket);
  }
  bucket.set(`${scope}:${userId}`, {
    value,
    vaultEpoch: snapshotVaultSessionEpoch(),
    authGeneration: snapshotAuthSessionGeneration(),
    savedAt: Date.now(),
  });
}

/** Financial reads stay memory-only; newest response wins and visible pending work polls at 15s. */
export function useCommerceRead<T>(
  scope: string,
  load: (token: string) => Promise<T>,
  shouldPoll: (value: T) => boolean,
  active = true,
  options?: { warmSnapshot?: boolean },
) {
  const warmSnapshot = options?.warmSnapshot === true;
  const { user, userId, capture } = useCommerceSession(scope, active);
  const [result, setResult] = useState<{ value: T; user: typeof user; scope: string } | null>(() => {
    if (!warmSnapshot || !user || !userId) return null;
    const warm = peekWarmCommerceRead(load, scope, userId);
    return warm !== null ? { value: warm, user, scope } : null;
  });
  const data = result && result.user === user && result.scope === scope ? result.value : null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!user) return;
    const current = capture();
    const read = ++sequence.current;
    const latest = () => current() && sequence.current === read;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      if (!latest()) return;
      const value = await load(token);
      if (latest()) {
        if (warmSnapshot) storeWarmCommerceRead(load, scope, userId, value);
        setResult({ value, user, scope });
        setError(null);
      }
    } catch {
      if (latest()) setError("Payment status could not be checked. Refresh before continuing.");
    } finally {
      // Only the latest mounted read owns this spinner. Settling it publishes no
      // financial result and must also work when authentication retires that read.
      if (sequence.current === read) setLoading(false);
    }
  }, [user, userId, scope, load, capture, warmSnapshot]);
  useEffect(() => {
    const warm = warmSnapshot && user && userId ? peekWarmCommerceRead(load, scope, userId) : null;
    setResult(warm !== null && user ? { value: warm, user, scope } : null);
    setError(null);
    setLoading(false);
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
  }, [refresh, scope, warmSnapshot, user, userId, load]);
  usePeriodicTask(`commerce:${scope}:${userId || "signed-out"}`, 15_000, () => refresh(), {
    // A session change can retire the initial read without a result or error.
    // Retry with fresh authority rather than leaving that review permanently blank.
    enabled: Boolean(user && !loading && (data ? shouldPoll(data) : !error)),
  });
  return { user, userId, data, refresh, loading, error, capture };
}
