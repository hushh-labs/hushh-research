"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  GoogleCalendarService,
  GoogleCalendarError,
  type CalendarReadRecovery,
  type CalendarEventSummary,
  type CalendarEventTime,
} from "@/lib/services/google-calendar-service";

export type RedactedCalendarEvent = {
  /** Provider event identifier, held only in memory to reconcile private task state. */
  id: string | null;
  title: string;
  start: CalendarEventTime;
  end: CalendarEventTime;
  status: string | null;
  /**
   * A verified Google Meet URL. This remains in React memory with the event
   * list; it is not written to a cache, analytics payload, or Feed history.
   */
  conferenceUrl?: string;
};

export type UseCalendarUpcomingEventsParams = {
  userId: string | null;
  vaultOwnerToken: string | null;
  isConnected: boolean;
  /** Look-ahead window from "now", recomputed on every fetch. Default 48h. */
  windowHours?: number;
};

export type UseCalendarUpcomingEventsResult = {
  events: RedactedCalendarEvent[];
  loading: boolean;
  error: string | null;
  recovery: CalendarReadRecovery | null;
  loaded: boolean;
  refresh: () => void;
};

/**
 * The ONLY function permitted to read GoogleCalendarService.listEvents()'s
 * raw response. Redacts to title/start/end/status and a verified Google Meet
 * URL only. raw.description, raw.location, raw.attendees, and raw.html_link
 * must never leave this function.
 */
function googleMeetUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "meet.google.com" &&
      !url.username && !url.password && !url.port
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function redactEvent(raw: CalendarEventSummary): RedactedCalendarEvent {
  const conferenceUrl = googleMeetUrl(raw.conference_url);
  return {
    id: raw.id ?? null,
    title: raw.title,
    start: raw.start ?? null,
    end: raw.end ?? null,
    status: raw.status ?? null,
    ...(conferenceUrl ? { conferenceUrl } : {}),
  };
}

/**
 * Fetches and redacts the caller's own upcoming Calendar events. No cap
 * here -- capping/sorting for display is the rendering card's job, mirroring
 * AgentGmailNudgeCard's own responsibility for its data. Needs no
 * idTokenProvider: unlike Gmail's sealed-header auth, listEvents() only
 * needs vaultOwnerToken (see GoogleCalendarService.listEvents's doc
 * comment) -- a real simplification, not an oversight.
 */
export function useCalendarUpcomingEvents({
  userId,
  vaultOwnerToken,
  isConnected,
  windowHours = 48,
}: UseCalendarUpcomingEventsParams): UseCalendarUpcomingEventsResult {
  // A fresh marker is derived from the connection props without retaining a
  // vault token in state. A render with a new owner cannot display an old
  // snapshot even before the effect has invalidated its in-flight request.
  const identity = useMemo(
    () => Symbol(
      `calendar-${Boolean(userId)}-${Boolean(vaultOwnerToken)}-${isConnected}-${windowHours}`,
    ),
    [userId, vaultOwnerToken, isConnected, windowHours],
  );
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const requestRef = useRef(0);
  const [snapshot, setSnapshot] = useState<{
    identity: symbol;
    events: RedactedCalendarEvent[];
    loading: boolean;
    error: string | null;
    recovery: CalendarReadRecovery | null;
    loaded: boolean;
  }>({ identity, events: [], loading: false, error: null, recovery: null, loaded: false });
  const canLoad = Boolean(isConnected && userId && vaultOwnerToken);
  const current = canLoad && snapshot.identity === identity;

  useEffect(() => {
    identityRef.current = identity;
    requestRef.current += 1;
    return () => { requestRef.current += 1; };
  }, [identity]);

  const load = useCallback(async () => {
    if (
      !isConnected ||
      !userId ||
      !vaultOwnerToken ||
      identityRef.current !== identity
    ) return;
    const request = ++requestRef.current;
    setSnapshot({
      identity, events: [], loading: true, error: null, recovery: null, loaded: false,
    });
    try {
      const now = new Date();
      const rangeEnd = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
      const response = await GoogleCalendarService.listEvents({
        vaultOwnerToken,
        startAt: now.toISOString(),
        endAt: rangeEnd.toISOString(),
      });
      if (request !== requestRef.current || identityRef.current !== identity) {
        return;
      }
      setSnapshot({
        identity,
        events: (response.events ?? []).map(redactEvent),
        loading: false,
        error: null,
        recovery: null,
        loaded: true,
      });
    } catch (error) {
      if (request !== requestRef.current || identityRef.current !== identity) {
        return;
      }
      setSnapshot({
        identity,
        events: [],
        loading: false,
        error: error instanceof GoogleCalendarError
          ? error.message : "Calendar details couldn’t load. Refresh to try again.",
        recovery: error instanceof GoogleCalendarError ? error.recovery : "retry",
        loaded: true,
      });
    }
  }, [identity, isConnected, userId, vaultOwnerToken, windowHours]);

  useEffect(() => {
    if (canLoad && (!current || (!snapshot.loaded && !snapshot.loading))) void load();
  }, [canLoad, current, snapshot.loaded, snapshot.loading, load]);

  return {
    events: current ? snapshot.events : [],
    loading: current && snapshot.loading,
    error: current ? snapshot.error : null,
    recovery: current ? snapshot.recovery : null,
    loaded: current && snapshot.loaded,
    refresh: () => void load(),
  };
}
