"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { registerPeriodicTask } from "@/lib/perf/idle-scheduler";
import {
  FEED_STATE_CHANGED_EVENT,
  feedStateChangeReason,
} from "@/lib/feed/feed-events";

import {
  GoogleCalendarService,
  type CalendarEventSummary,
  type CalendarEventTime,
} from "@/lib/services/google-calendar-service";

export type RedactedCalendarEvent = {
  id?: string;
  reminderSelected?: boolean;
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
  reminderId?: string | null;
};

export type UseCalendarUpcomingEventsResult = {
  events: RedactedCalendarEvent[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
  refresh: () => void;
};

/**
 * The ONLY function permitted to read GoogleCalendarService.listEvents()'s
 * raw response. Redacts to title/start/end/status and a verified Google Meet
 * URL only. raw.description, raw.location, raw.attendees, and raw.html_link
 * must never leave this function.
 */
export function googleMeetUrl(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "meet.google.com" &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function redactEvent(raw: CalendarEventSummary): RedactedCalendarEvent {
  const conferenceUrl = googleMeetUrl(raw.conference_url);
  return {
    ...(raw.id ? { id: raw.id } : {}),
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
  reminderId,
}: UseCalendarUpcomingEventsParams): UseCalendarUpcomingEventsResult {
  const [events, setEvents] = useState<RedactedCalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const identity = `${userId}:${vaultOwnerToken}:${isConnected}`;
  const active = useRef(identity);
  active.current = identity;
  const request = useRef(0);
  const inFlight = useRef<{ owner: string; sequence: number } | null>(null);
  const [resultIdentity, setResultIdentity] = useState(identity);

  const canLoad = Boolean(isConnected && userId && vaultOwnerToken);

  const load = useCallback(async () => {
    if (!userId || !vaultOwnerToken || !isConnected) return;
    const owner = identity;
    if (inFlight.current?.owner === owner) return;
    const sequence = ++request.current;
    inFlight.current = { owner, sequence };
    const current = () =>
      active.current === owner && request.current === sequence;
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const rangeEnd = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
      const [list, selection] = await Promise.allSettled([
        GoogleCalendarService.listEvents({
          vaultOwnerToken,
          startAt: now.toISOString(),
          endAt: rangeEnd.toISOString(),
        }),
        reminderId
          ? GoogleCalendarService.resolveReminder(vaultOwnerToken, reminderId)
          : Promise.resolve(null),
      ]);
      if (!current()) return;
      let next =
        list.status === "fulfilled"
          ? (list.value.events ?? [])
              .filter(
                (event) => event.status !== "cancelled" && !event.is_declined,
              )
              .map(redactEvent)
          : [];
      if (list.status === "rejected")
        setError("Calendar details couldn’t load.");
      if (selection.status === "fulfilled" && selection.value) {
        const selected = redactEvent(selection.value);
        if (
          selected.end?.dateTime &&
          Date.parse(selected.end.dateTime) <= Date.now()
        )
          setError("This meeting has ended.");
        else
          next = [
            { ...selected, reminderSelected: true },
            ...next.filter((event) => event.id !== selected.id),
          ];
      } else if (reminderId)
        setError("This meeting changed or is no longer available.");
      if (!current()) return;
      setResultIdentity(owner);
      setEvents(next);
    } catch {
      if (current())
        setError("Calendar details couldn’t load. Refresh to try again.");
    } finally {
      if (current()) {
        setLoaded(true);
        setLoading(false);
      }
      if (inFlight.current?.sequence === sequence) inFlight.current = null;
    }
  }, [userId, vaultOwnerToken, windowHours, isConnected, identity, reminderId]);

  const invalidateRequests = useCallback(() => {
    ++request.current;
    inFlight.current = null;
  }, []);
  useEffect(() => {
    setEvents([]);
    setLoaded(false);
    setError(null);
    setLoading(false);
    if (!canLoad) return;
    void load();
    const cleanup = registerPeriodicTask({
      id: `calendar-upcoming:${userId}`,
      intervalMs: 60_000,
      run: load,
    });
    const resume = (event: Event) => {
      if (
        document.visibilityState === "visible" &&
        (event.type !== FEED_STATE_CHANGED_EVENT ||
          feedStateChangeReason(event) !== "read")
      )
        void load();
    };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener(FEED_STATE_CHANGED_EVENT, resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      invalidateRequests();
      cleanup();
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener(FEED_STATE_CHANGED_EVENT, resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [canLoad, load, userId, invalidateRequests]);

  return {
    events: canLoad && resultIdentity === identity ? events : [],
    loading,
    error,
    loaded,
    refresh: () => void load(),
  };
}
