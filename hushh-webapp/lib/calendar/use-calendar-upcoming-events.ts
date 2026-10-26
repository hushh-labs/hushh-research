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
  complete?: boolean;
};

/** Owner-only task context. This projection is never passed to chat. */
export type TodoCalendarEvent = RedactedCalendarEvent & { context?: string; legacyId?: string | null; meetingRef?: string };

async function todoEvent(raw: CalendarEventSummary): Promise<TodoCalendarEvent> {
  const event = redactEvent(raw);
  const people = [...new Set([
    ...(raw.attendees ?? []).filter(person => !person.self).map(person => person.display_name || person.email),
    ...(!raw.organizer?.self ? [raw.organizer?.displayName || raw.organizer?.email] : []),
  ].filter((value): value is string => Boolean(value)))].slice(0, 12);
  // Preserve legacy primary-calendar ids; other calendar/account records have
  // distinct identities even when Google uses the same event id.
  let id = raw.id;
  if (id && ((raw.account_id && raw.account_id !== "default") || (raw.calendar_id && raw.calendar_id !== "primary"))) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([raw.account_id ?? "default", raw.calendar_id ?? "primary", id])));
    id = `event_${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("")}`;
  }
  return { ...event, id: id ?? null, legacyId: raw.id,
    ...(raw.ical_uid && raw.start?.dateTime ? { meetingRef: JSON.stringify([raw.ical_uid, new Date(raw.start.dateTime).toISOString()]) } : {}),
    context: [people.length ? `With ${people.join(", ")}` : "Scheduled on your Calendar", raw.calendar_name, raw.account_email].filter(Boolean).join(" · ").slice(0, 1200) };
}

/**
 * Chat receives only title/start/end/status and a verified Meet URL. The
 * separate owner task projection may expose bounded participant labels.
 * Neither projection includes message bodies, descriptions or raw links.
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
export function useCalendarUpcomingEvents(params: UseCalendarUpcomingEventsParams): UseCalendarUpcomingEventsResult {
  return useCalendarEventProjection(params, redactEvent);
}

export function useTodoUpcomingEvents(params: UseCalendarUpcomingEventsParams): Omit<UseCalendarUpcomingEventsResult, "events"> & { events: TodoCalendarEvent[] } {
  return useCalendarEventProjection(params, todoEvent);
}

function useCalendarEventProjection<T extends RedactedCalendarEvent>({
  userId,
  vaultOwnerToken,
  isConnected,
  windowHours = 48,
}: UseCalendarUpcomingEventsParams, project: (event: CalendarEventSummary) => T | Promise<T>) {
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
    events: T[];
    complete: boolean;
    loading: boolean;
    error: string | null;
    recovery: CalendarReadRecovery | null;
    loaded: boolean;
  }>({ identity, events: [], complete: false, loading: false, error: null, recovery: null, loaded: false });
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
      identity, events: [], complete: false, loading: true, error: null, recovery: null, loaded: false,
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
      const events = await Promise.all((response.events ?? []).map(project));
      if (request !== requestRef.current || identityRef.current !== identity) return;
      setSnapshot({
        identity,
        events,
        complete: response.has_more !== true && response.truncated !== true,
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
        complete: false,
        loading: false,
        error: error instanceof GoogleCalendarError
          ? error.message : "Calendar details couldn’t load. Refresh to try again.",
        recovery: error instanceof GoogleCalendarError ? error.recovery : "retry",
        loaded: true,
      });
    }
  }, [identity, isConnected, userId, vaultOwnerToken, windowHours, project]);

  useEffect(() => {
    if (canLoad && (!current || (!snapshot.loaded && !snapshot.loading))) void load();
  }, [canLoad, current, snapshot.loaded, snapshot.loading, load]);

  return {
    events: current ? snapshot.events : [],
    loading: current && snapshot.loading,
    error: current ? snapshot.error : null,
    recovery: current ? snapshot.recovery : null,
    loaded: current && snapshot.loaded,
    complete: current && snapshot.complete,
    refresh: () => void load(),
  };
}
