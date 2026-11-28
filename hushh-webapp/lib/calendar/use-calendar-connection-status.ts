"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import {
  GoogleCalendarService,
  type GoogleCalendarStatus,
} from "@/lib/services/google-calendar-service";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

const MAX_SETTLED_CALENDAR_SNAPSHOTS = 8;
const settledCalendarStatuses = new Map<string, GoogleCalendarStatus>();

function calendarCacheKey(userId: string | null): string | null {
  if (!userId) return null;
  const principal = snapshotValidatedAuthSessionPrincipal();
  if (!principal || principal.ownerId !== userId) return null;
  return `${userId}:${principal.generation}:${snapshotVaultSessionEpoch()}`;
}

export function seedCalendarConnectionStatus(
  userId: string | null,
  status: GoogleCalendarStatus,
): void {
  const key = calendarCacheKey(userId);
  if (!key) return;
  if (!settledCalendarStatuses.has(key) && settledCalendarStatuses.size >= MAX_SETTLED_CALENDAR_SNAPSHOTS) {
    const oldest = settledCalendarStatuses.keys().next().value;
    if (oldest !== undefined) settledCalendarStatuses.delete(oldest);
  }
  settledCalendarStatuses.set(key, status);
}

export type UseCalendarConnectionStatusParams = {
  userId: string | null;
  idTokenProvider: (() => Promise<string>) | null;
  enabled?: boolean;
};

export type UseCalendarConnectionStatusResult = {
  status: GoogleCalendarStatus | null;
  connected: boolean;
  loading: boolean;
  error: string | null;
  loaded: boolean;
  refresh: () => void;
};

/** Connection evidence belongs to one owner and the latest status request. */
export function useCalendarConnectionStatus({
  userId,
  idTokenProvider,
  enabled = true,
}: UseCalendarConnectionStatusParams): UseCalendarConnectionStatusResult {
  const canLoad = Boolean(enabled && userId && idTokenProvider);
  const identity = useMemo(() => Symbol(`calendar-status-${Boolean(userId)}-${canLoad}`), [userId, canLoad]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const providerRef = useRef(idTokenProvider);
  providerRef.current = idTokenProvider;
  const requestRef = useRef(0);
  const warmKey = canLoad ? calendarCacheKey(userId) : null;
  const warmStatus = warmKey ? settledCalendarStatuses.get(warmKey) : undefined;
  const [snapshot, setSnapshot] = useState<{
    identity: symbol;
    status: GoogleCalendarStatus | null;
    loading: boolean;
    error: string | null;
    loaded: boolean;
  }>(() => ({
    identity,
    status: warmStatus ?? null,
    loading: false,
    error: null,
    loaded: warmStatus !== undefined,
  }));
  const current = canLoad && snapshot.identity === identity;

  useEffect(() => () => {
    requestRef.current += 1;
  }, [identity]);

  const load = useCallback(async () => {
    if (!canLoad || !userId || !providerRef.current || identityRef.current !== identity) return;
    const request = ++requestRef.current;
    const isCurrent = () => requestRef.current === request && identityRef.current === identity;
    const cached = calendarCacheKey(userId)
      ? settledCalendarStatuses.get(calendarCacheKey(userId)!)
      : undefined;
    setSnapshot((prev) =>
      prev.identity === identity && prev.loaded
        ? { ...prev, loading: true, error: null }
        : {
            identity,
            status: cached ?? null,
            loading: true,
            error: null,
            loaded: cached !== undefined,
          },
    );
    try {
      const idToken = await providerRef.current();
      if (!isCurrent()) return;
      const status = await GoogleCalendarService.status(idToken, userId);
      if (!isCurrent()) return;
      seedCalendarConnectionStatus(userId, status);
      setSnapshot({ identity, status, loading: false, error: null, loaded: true });
    } catch {
      if (!isCurrent()) return;
      setSnapshot({ identity, status: null, loading: false,
        error: "Calendar connection details couldn’t load. Refresh to try again.", loaded: true });
    }
  }, [canLoad, userId, identity]);
  const refresh = useCallback(() => void load(), [load]);

  useEffect(() => {
    if (canLoad && (!current || !snapshot.loading)) void load();
  }, [canLoad, current, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = current ? snapshot.status : warmStatus ?? null;
  const loaded = current ? snapshot.loaded : warmStatus !== undefined;
  return {
    status,
    connected: status?.connected === true && status.status !== "needs_reauth",
    loading: current && snapshot.loading,
    error: current ? snapshot.error : null,
    loaded: canLoad && loaded,
    refresh,
  };
}
