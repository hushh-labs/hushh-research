import type { CalendarEventSummary } from "@/lib/services/google-calendar-service";

const HOLIDAY_CALENDAR_ID = /^[a-zA-Z0-9_.-]+#holiday@group\.v\.calendar\.google\.com$/;
const NON_SCHEDULED_TYPES = new Set([
  "birthday", "focusTime", "fromGmail", "outOfOffice", "workingLocation",
]);

export function boardOccasionKind(event: CalendarEventSummary): "birthday" | "holiday" | null {
  if (event.event_type === "birthday") return "birthday";
  return HOLIDAY_CALENDAR_ID.test(event.source_calendar_id || event.calendar_id || "") ? "holiday" : null;
}

/** Count ordinary scheduled events while keeping observances visible on the board. */
export function isCountedBoardEvent(event: CalendarEventSummary): boolean {
  if (event.status === "cancelled") return false;
  if (event.event_type && NON_SCHEDULED_TYPES.has(event.event_type)) return false;
  return boardOccasionKind(event) === null;
}
