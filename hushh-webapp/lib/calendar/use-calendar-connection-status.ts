"use client";

import { useCallback, useEffect, useState } from "react";

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
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const canLoad = Boolean(enabled && userId && idTokenProvider);

  const load = useCallback(async () => {
    if (!userId || !idTokenProvider) return;
    setLoading(true);
    setError(null);
    try {
      const idToken = await idTokenProvider();
      setStatus(await GoogleCalendarService.status(idToken, userId));
    } catch {
      setError("Calendar connection details couldn’t load. Refresh to try again.");
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }, [userId, idTokenProvider]);

  useEffect(() => {
    if (canLoad && !loaded && !loading) void load();
  }, [canLoad, loaded, loading, load]);

  return {
    status,
    connected: status?.connected === true && status.status !== "needs_reauth",
    loading,
    error,
    loaded,
    refresh: () => void load(),
  };
}
