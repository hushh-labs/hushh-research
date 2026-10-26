/** Authorized Calendar event wire values, separate from transport. */
export type CalendarEventTime = { dateTime?: string; date?: string; timeZone?: string } | null;

/**
 * The RAW backend event shape (matches _event_summary() in
 * hushh_mcp/services/google_calendar_service.py exactly, including
 * description/location/attendees). listEvents() below returns this
 * unredacted for the authenticated owner workspace. Chat redaction remains
 * lib/calendar/use-calendar-upcoming-events.ts's responsibility.
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
  attendees?: { email?: string | null; response_status?: string | null; display_name?: string | null; self?: boolean }[];
  html_link?: string | null;
  conference_url?: string | null;
  conference_status?: string | null;
  updated?: string | null;
  transparency?: string | null;
  ical_uid?: string | null;
  original_start_time?: CalendarEventTime;
};

export type CalendarEventsResponse = {
  events: CalendarEventSummary[];
  time_zone?: string | null;
  has_more?: boolean;
  truncated?: boolean;
};
