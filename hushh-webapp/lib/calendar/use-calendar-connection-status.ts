"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  GoogleCalendarService,
  type GoogleCalendarStatus,
} from "@/lib/services/google-calendar-service";

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
  const [snapshot, setSnapshot] = useState<{
    identity: symbol;
    status: GoogleCalendarStatus | null;
    loading: boolean;
    error: string | null;
    loaded: boolean;
  }>({ identity, status: null, loading: false, error: null, loaded: false });
  const current = canLoad && snapshot.identity === identity;

  useEffect(() => () => {
    requestRef.current += 1;
  }, [identity]);

  const load = useCallback(async () => {
    if (!canLoad || !userId || !providerRef.current || identityRef.current !== identity) return;
    const request = ++requestRef.current;
    const isCurrent = () => requestRef.current === request && identityRef.current === identity;
    setSnapshot({ identity, status: null, loading: true, error: null, loaded: false });
    try {
      const idToken = await providerRef.current();
      if (!isCurrent()) return;
      const status = await GoogleCalendarService.status(idToken, userId);
      if (!isCurrent()) return;
      setSnapshot({ identity, status, loading: false, error: null, loaded: true });
    } catch {
      if (!isCurrent()) return;
      setSnapshot({ identity, status: null, loading: false,
        error: "Calendar connection details couldn’t load. Refresh to try again.", loaded: true });
    }
  }, [canLoad, userId, identity]);

  useEffect(() => {
    if (canLoad && (!current || (!snapshot.loaded && !snapshot.loading))) void load();
  }, [canLoad, current, snapshot.loaded, snapshot.loading, load]);

  const status = current ? snapshot.status : null;
  return {
    status,
    connected: status?.connected === true && status.status !== "needs_reauth",
    loading: current && snapshot.loading,
    error: current ? snapshot.error : null,
    loaded: current && snapshot.loaded,
    refresh: () => void load(),
  };
}
