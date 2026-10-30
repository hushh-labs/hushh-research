/** Memory-only context for the existing conversation; grants no action authority. */
export type CalendarInvitationHandoff = {
  ownerId: string;
  accountEmail: string;
  calendarId: string;
  eventId: string;
  decision?: "view" | "accepted" | "declined" | "offer_times";
  timeZone?: string;
  request?: string;
  startAt?: string;
  endAt?: string;
};

/** Selected context is re-read by the Calendar tools; it never authorizes a write. */
export function calendarInvitationInstruction(selection: CalendarInvitationHandoff) {
  return [
    "Selected Calendar invitation (context only; no RSVP or Mail authorization):",
    JSON.stringify({ calendarId: selection.calendarId, eventId: selection.eventId, accountEmail: selection.accountEmail, timeZone: selection.timeZone, startAt: selection.startAt, endAt: selection.endAt }),
    "Interpret the owner's original request as written. Read calendar_invitations for this window with these selected IDs and expected_account_email, then resolve its exact ordinal before opening its review. Preserve the requested decision, alternative date/window, duration and organizer message in the review inputs. Ask when required terms are missing. Do not create, reschedule or cancel the organizer's event. The browser confirmation owns every provider effect.",
  ].join("\n");
}

/** Settlement of an explicit browser-confirmed action; never model input or persisted. */
export type CalendarAttendanceHandoff = {
  ownerId: string;
  epoch: number;
  title: string;
  recipient: string;
  outcome: Promise<{ result: import("@/lib/services/google-calendar-service").CalendarAttendanceResult } | { error: string }>;
};
