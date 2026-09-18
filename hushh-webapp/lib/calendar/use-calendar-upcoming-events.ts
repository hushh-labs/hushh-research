"use client";

import { useCallback, useEffect, useState } from "react";

import {
  GoogleCalendarService,
  type CalendarEventSummary,
  type CalendarEventTime,
} from "@/lib/services/google-calendar-service";

export type RedactedCalendarEvent = {
  title: string;
  start: CalendarEventTime;
  end: CalendarEventTime;
  status: string | null;
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
  loaded: boolean;
  refresh: () => void;
};

/**
 * The ONLY function permitted to read GoogleCalendarService.listEvents()'s
 * raw response. Mirrors mcp_modules/tools/gmail_calendar_tools.py's
 * handle_list_upcoming_calendar_events redaction exactly (title/start/end/
 * status only) -- see
 * consent-protocol/tests/test_gmail_calendar_tools.py::test_list_events_redacts_sensitive_fields
 * for the server-side proof of the same contract. raw.description,
 * raw.location, raw.attendees, and raw.html_link must never leave this
 * function.
 */
function redactEvent(raw: CalendarEventSummary): RedactedCalendarEvent {
  return {
    title: raw.title,
    start: raw.start ?? null,
    end: raw.end ?? null,
    status: raw.status ?? null,
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
  const [events, setEvents] = useState<RedactedCalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const canLoad = Boolean(isConnected && userId && vaultOwnerToken);

  const load = useCallback(async () => {
    if (!userId || !vaultOwnerToken) return;
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const rangeEnd = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
      const response = await GoogleCalendarService.listEvents({
        vaultOwnerToken,
        startAt: now.toISOString(),
        endAt: rangeEnd.toISOString(),
      });
      setEvents((response.events ?? []).map(redactEvent));
    } catch {
      setError("Calendar details couldn’t load. Refresh to try again.");
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }, [userId, vaultOwnerToken, windowHours]);

  useEffect(() => {
    if (canLoad && !loaded && !loading) void load();
  }, [canLoad, loaded, loading, load]);

  return {
    events: isConnected ? events : [],
    loading,
    error,
    loaded,
    refresh: () => void load(),
  };
}
