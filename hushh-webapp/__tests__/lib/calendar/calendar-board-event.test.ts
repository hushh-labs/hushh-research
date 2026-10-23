import { describe, expect, it } from "vitest";
import { boardOccasionKind, isCountedBoardEvent } from "@/lib/calendar/calendar-board-event";
import type { CalendarEventSummary } from "@/lib/services/google-calendar-service";

const event = (values: Partial<CalendarEventSummary> = {}): CalendarEventSummary => ({
  title: "Team meeting", start: { dateTime: "2026-10-23T10:00:00Z" },
  end: { dateTime: "2026-10-23T10:30:00Z" }, event_type: "default", ...values,
});

describe("calendar board event count", () => {
  it("counts ordinary meetings with or without a conference link", () => {
    expect(isCountedBoardEvent(event())).toBe(true);
    expect(isCountedBoardEvent(event({ conference_url: "https://meet.google.com/abc-defg-hij" }))).toBe(true);
    expect(isCountedBoardEvent(event({ event_type: undefined }))).toBe(true);
  });

  it("does not count Google birthdays, holidays, or other special calendar entries", () => {
    for (const event_type of ["birthday", "focusTime", "fromGmail", "outOfOffice", "workingLocation"]) {
      expect(isCountedBoardEvent(event({ event_type }))).toBe(false);
    }
    expect(isCountedBoardEvent(event({ source_calendar_id: "en.indian#holiday@group.v.calendar.google.com" }))).toBe(false);
    expect(isCountedBoardEvent(event({ status: "cancelled" }))).toBe(false);
    expect(boardOccasionKind(event({ event_type: "birthday" }))).toBe("birthday");
    expect(boardOccasionKind(event({ source_calendar_id: "en.indian#holiday@group.v.calendar.google.com" }))).toBe("holiday");
    expect(boardOccasionKind(event({ event_type: "focusTime" }))).toBeNull();
  });

  it("does not classify an event by its title or by being all day", () => {
    expect(isCountedBoardEvent(event({ title: "Birthday planning meeting" }))).toBe(true);
    expect(isCountedBoardEvent(event({ start: { date: "2026-10-23" }, end: { date: "2026-10-24" } }))).toBe(true);
    expect(isCountedBoardEvent(event({ source_calendar_id: "user@group.v.calendar.google.com", title: "Holiday prep" }))).toBe(true);
  });
});
