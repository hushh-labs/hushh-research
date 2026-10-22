import type { CalendarEventSummary, CalendarEventTime } from "@/lib/services/google-calendar-service";

// Leaves room for the event, occurrence, greeting and sign-off inside the API's 8000-character message limit.
export const MAX_CALENDAR_DECLINE_REASON_LENGTH = 7000;

type ReviewedOccurrence = { title: string; start?: CalendarEventTime; end?: CalendarEventTime; recipient?: string | null };

/** A review fetches the latest provider event; never send prose composed for an older occurrence. */
export function sameCalendarInvitationOccurrence(event: CalendarEventSummary, review: ReviewedOccurrence): boolean {
  const sameTime = (left: CalendarEventTime | undefined, right: CalendarEventTime | undefined) => {
    if (left?.date || right?.date) return Boolean(left?.date) && left?.date === right?.date;
    const leftTime = left?.dateTime ? Date.parse(left.dateTime) : NaN;
    const rightTime = right?.dateTime ? Date.parse(right.dateTime) : NaN;
    return Number.isFinite(leftTime) && leftTime === rightTime;
  };
  return event.title === review.title && sameTime(event.start, review.start) && sameTime(event.end, review.end)
    && event.organizer?.email?.toLowerCase() === review.recipient?.toLowerCase();
}

/** The owner's reason stays intact; this draft is shown in the Calendar review before sending. */
export function calendarDeclineMessage(event: CalendarEventSummary, zone: string, reason: string): string {
  if (reason.length > MAX_CALENDAR_DECLINE_REASON_LENGTH) throw new Error("Shorten the reason before reviewing this email.");
  const organizer = event.organizer?.displayName?.replace(/\s+/g, " ").trim().slice(0, 80);
  const responder = event.attendees?.find(attendee => attendee.self)?.display_name?.replace(/\s+/g, " ").trim().slice(0, 80);
  const title = event.title?.replace(/\s+/g, " ").trim().slice(0, 240) || "the meeting";
  const start = event.start?.dateTime ? new Date(event.start.dateTime) : null;
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  let when = "";
  if (start && end && Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end > start) {
    const day = new Intl.DateTimeFormat("en", { timeZone: zone, weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const clock = new Intl.DateTimeFormat("en", { timeZone: zone, hour: "numeric", minute: "2-digit" });
    const offsetClock = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "shortOffset" });
    const offsetAt = (value: Date) => offsetClock.formatToParts(value).find(part => part.type === "timeZoneName")?.value || "";
    const startOffset = offsetAt(start);
    const endOffset = offsetAt(end);
    when = day.format(start) === day.format(end)
      ? `${day.format(start)}, ${clock.format(start)}${startOffset && startOffset !== endOffset ? ` (${startOffset})` : ""} to ${clock.format(end)}${endOffset ? ` (${endOffset})` : ""}`
      : `${day.format(start)}, ${clock.format(start)}${startOffset ? ` (${startOffset})` : ""} to ${day.format(end)}, ${clock.format(end)}${endOffset ? ` (${endOffset})` : ""}`;
  } else if (event.start?.date) {
    when = new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${event.start.date}T12:00:00Z`));
  }
  return [
    organizer ? `Hi ${organizer},` : "Hello,",
    `I’m sorry, but I can’t attend “${title}”${when ? ` on ${when}` : ""}.`,
    reason.trim(),
    "Thank you for understanding.",
    responder ? `Best,\n${responder}` : "",
  ].filter(Boolean).join("\n\n");
}
