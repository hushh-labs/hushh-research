import {
  getSessionItem,
  removeSessionItem,
  setSessionItem,
} from "@/lib/utils/session-storage";

const CALENDAR_SETUP_RETURN_KEY = "one_calendar_oauth_setup_return_v1";
const MEETING_RETURN_KEY = "one_calendar_meeting_oauth_return_v1";
const RETURN_MAX_AGE_MS = 15 * 60 * 1000;

export type CalendarMeetingReturnContext = {
  accountId: string;
  day: string;
  timeZone: string;
  filter: "all" | "recording" | "notes";
  query: string;
  /** The meeting that was open, so a return lands on it instead of the day's list. */
  occurrenceId?: string;
  /** Files the person had chosen to request, restored with the meeting. */
  requestedTypes?: ("recording" | "notes")[];
};

export function validCalendarMeetingReturn(value: unknown): value is CalendarMeetingReturnContext {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CalendarMeetingReturnContext>;
  return typeof item.accountId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item.accountId) &&
    typeof item.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.day) &&
    typeof item.timeZone === "string" && /^[A-Za-z0-9_+\/-]{1,100}$/.test(item.timeZone) &&
    (item.filter === "all" || item.filter === "recording" || item.filter === "notes") &&
    typeof item.query === "string" && item.query.length <= 120 &&
    (item.occurrenceId === undefined || (typeof item.occurrenceId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item.occurrenceId))) &&
    (item.requestedTypes === undefined || (Array.isArray(item.requestedTypes) && item.requestedTypes.length <= 2 &&
      item.requestedTypes.every(kind => kind === "recording" || kind === "notes")));
}

/** One-shot UI coordinates only. OAuth state, provider IDs and file content stay out of storage. */
export function markCalendarMeetingOAuthReturn(ownerId: string, context: CalendarMeetingReturnContext): void {
  if (!ownerId || !validCalendarMeetingReturn(context)) return;
  setSessionItem(MEETING_RETURN_KEY, JSON.stringify({ ownerId, context, savedAt: Date.now() }));
}

export function consumeCalendarMeetingOAuthReturn(ownerId: string): CalendarMeetingReturnContext | null {
  const raw = getSessionItem(MEETING_RETURN_KEY);
  removeSessionItem(MEETING_RETURN_KEY);
  try {
    const value = JSON.parse(raw || "") as { ownerId?: string; context?: unknown; savedAt?: number };
    return value.ownerId === ownerId && typeof value.savedAt === "number" &&
      Date.now() >= value.savedAt && Date.now() - value.savedAt <= RETURN_MAX_AGE_MS &&
      validCalendarMeetingReturn(value.context) ? value.context : null;
  } catch { return null; }
}

/** Store only the redacted callback destination, never OAuth state or tokens. */
export function markCalendarSetupOAuthReturn(): void {
  setSessionItem(CALENDAR_SETUP_RETURN_KEY, "1");
}

export function clearCalendarSetupOAuthReturn(): void {
  removeSessionItem(CALENDAR_SETUP_RETURN_KEY);
}

/** Consume the one-browser setup continuation after the callback settles. */
export function consumeCalendarSetupOAuthReturn(): boolean {
  const shouldReturnToSetup = getSessionItem(CALENDAR_SETUP_RETURN_KEY) === "1";
  removeSessionItem(CALENDAR_SETUP_RETURN_KEY);
  return shouldReturnToSetup;
}
