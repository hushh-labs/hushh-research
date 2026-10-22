import { describe, expect, it } from "vitest";
import { MAX_CALENDAR_DECLINE_REASON_LENGTH, calendarDeclineMessage, sameCalendarInvitationOccurrence } from "@/lib/calendar/calendar-recipient-copy";
import type { CalendarEventSummary } from "@/lib/services/google-calendar-service";

const event: CalendarEventSummary = {
  title: "Review meeting",
  start: { dateTime: "2026-11-01T05:30:00Z" },
  end: { dateTime: "2026-11-01T06:30:00Z" },
  organizer: { email: "priya@example.com", displayName: "Priya Mehta" },
  attendees: [{ email: "owner@example.com", self: true, display_name: "Sharu Khan" }],
};

describe("Calendar recipient copy", () => {
  it("keeps the owner's exact reason and labels both offsets through a daylight-saving change", () => {
    const body = calendarDeclineMessage(event, "America/New_York", "I have a family commitment.");
    expect(body).toContain("Hi Priya Mehta,");
    expect(body).toContain("1:30 AM (GMT-4) to 1:30 AM (GMT-5)");
    expect(body).toContain("I have a family commitment.");
    expect(body).toContain("Best,\nSharu Khan");
  });

  it("fits the API message limit without truncating the reason", () => {
    const reason = "x".repeat(MAX_CALENDAR_DECLINE_REASON_LENGTH);
    const body = calendarDeclineMessage({ ...event, title: "M".repeat(1000) }, "UTC", reason);
    expect(body).toContain(reason);
    expect(body.length).toBeLessThanOrEqual(8000);
    expect(() => calendarDeclineMessage(event, "UTC", `${reason}x`)).toThrow(/Shorten the reason/);
  });

  it("requires the reviewed occurrence and organizer to match the displayed invitation", () => {
    expect(sameCalendarInvitationOccurrence(event, { title: event.title, start: event.start, end: event.end, recipient: "PRIYA@example.com" })).toBe(true);
    expect(sameCalendarInvitationOccurrence(event, { title: event.title, start: { dateTime: "2026-11-01T07:30:00Z" }, end: event.end, recipient: "priya@example.com" })).toBe(false);
  });
});
