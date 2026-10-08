"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

/**
 * Intentionally standalone -- does NOT share state with
 * calendar-agent-page.tsx's own local status polling. That page's state is
 * entangled with OAuth-callback timing and onboarding-flow concerns
 * unrelated to this feature; duplicating ~15 lines here is lower risk than
 * refactoring tested, shipped code for one new consumer. Extract a shared
 * hook only once a third consumer needs the same thing, or this and that
 * page's logic visibly drift apart.
 *
 * "connected" mirrors calendar-agent-page.tsx's own definition exactly:
 * status.connected alone is not enough -- a needs_reauth status still
 * reports connected:true.
 */
export function useCalendarConnectionStatus({
  userId,
  idTokenProvider,
  enabled = true,
}: UseCalendarConnectionStatusParams): UseCalendarConnectionStatusResult {
  const [state, setState] = useState<{
    owner: string | null;
    status: GoogleCalendarStatus | null;
    loading: boolean;
    loaded: boolean;
    error: string | null;
  }>({ owner: null, status: null, loading: false, loaded: false, error: null });
  const active = useRef(userId);
  active.current = userId;
  const sequence = useRef(0);
  const inFlight = useRef<string | null>(null);
  const invalidate = useCallback(() => {
    sequence.current += 1;
    inFlight.current = null;
  }, []);
  useEffect(() => () => invalidate(), [userId, enabled, invalidate]);

  const canLoad = Boolean(enabled && userId && idTokenProvider);

  const load = useCallback(async () => {
    if (!enabled || !userId || !idTokenProvider || inFlight.current === userId)
      return;
    const request = ++sequence.current;
    const current = () =>
      active.current === userId && sequence.current === request;
    inFlight.current = userId;
    setState((previous) => ({
      ...previous,
      owner: userId,
      status: previous.owner === userId ? previous.status : null,
      loading: true,
      loaded: false,
      error: null,
    }));
    try {
      const idToken = await idTokenProvider();
      if (!current()) return;
      const status = await GoogleCalendarService.status(idToken, userId);
      if (current())
        setState({
          owner: userId,
          status,
          loading: false,
          loaded: true,
          error: null,
        });
    } catch {
      if (current())
        setState({
          owner: userId,
          status: null,
          loading: false,
          loaded: true,
          error:
            "Calendar connection details couldn’t load. Refresh to try again.",
        });
    } finally {
      if (sequence.current === request) inFlight.current = null;
    }
  }, [userId, idTokenProvider, enabled]);

  useEffect(() => {
    if (
      canLoad &&
      (state.owner !== userId || (!state.loaded && inFlight.current !== userId))
    )
      void load();
  }, [canLoad, state.owner, state.loaded, state.loading, userId, load]);

  const owned = canLoad && state.owner === userId;
  const status = owned ? state.status : null;

  return {
    status,
    connected: status?.connected === true && status.status !== "needs_reauth",
    loading: owned && state.loading,
    error: owned ? state.error : null,
    loaded: owned && state.loaded,
    refresh: () => void load(),
  };
}
