export type CalendarEventTime = { dateTime?: string; date?: string; timeZone?: string } | null;

/**
 * Calendar wire shape. The shared owner workspace may receive optional raw
 * details; the private To-do read returns an allowlisted subset. Chat/To-do
 * redaction remains use-calendar-upcoming-events.ts's responsibility.
 */
export type CalendarEventSummary = {
  account_id?: string;
  account_email?: string;
  id?: string | null;
  etag?: string | null;
  calendar_id?: string;
  source_calendar_id?: string;
  source_time_zone?: string | null;
  calendar_name?: string;
  calendar_color?: string | null;
  event_color?: string | null;
  color_id?: string | null;
  conference_name?: string | null;
  conference_icon?: string | null;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  can_decline?: boolean;
  title: string;
  description?: string | null;
  location?: string | null;
  start: CalendarEventTime;
  end: CalendarEventTime;
  status?: string | null;
  event_type?: string | null;
  attendees?: { email?: string | null; response_status?: string | null; display_name?: string | null; self?: boolean; comment?: string | null }[];
  html_link?: string | null;
  conference_url?: string | null;
  conference_status?: string | null;
  updated?: string | null;
  transparency?: string | null;
  ical_uid?: string | null;
  original_start_time?: CalendarEventTime;
  /** Dim this copy: the owner declined ("self"), or the one other person in a 1-to-1 did ("only_guest"). */
  decline_view?: { kind: "self" | "only_guest"; email: string; display_name: string | null; comment: string | null } | null;
};

export type CalendarEventsResponse = {
  events: CalendarEventSummary[];
  time_zone?: string | null;
  truncated?: boolean;
};
