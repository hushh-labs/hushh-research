import { describe, expect, it } from "vitest";

import { isCalendarEventEnded } from "@/lib/calendar/calendar-event-status";

describe("calendar event elapsed state", () => {
  it("changes at the exact timed end regardless of display timezone", () => {
    const event = { end: { dateTime: "2026-10-22T23:30:00+05:30" } };
    expect(isCalendarEventEnded(event, Date.parse("2026-10-22T17:59:59Z"), "America/Los_Angeles")).toBe(false);
    expect(isCalendarEventEnded(event, Date.parse("2026-10-22T18:00:00Z"), "America/Los_Angeles")).toBe(true);
  });

  it("uses Google's source time zone for an offset-free end", () => {
    const event = { end: { dateTime: "2026-10-23T10:00:00", timeZone: "America/Los_Angeles" } };
    expect(isCalendarEventEnded(event, Date.parse("2026-10-23T16:59:59Z"), "Asia/Kolkata")).toBe(false);
    expect(isCalendarEventEnded(event, Date.parse("2026-10-23T17:00:00Z"), "Asia/Kolkata")).toBe(true);
  });

  it("waits for the later occurrence of a repeated wall time", () => {
    const event = { end: { dateTime: "2026-11-01T01:30:00", timeZone: "America/Los_Angeles" } };
    expect(isCalendarEventEnded(event, Date.parse("2026-11-01T08:30:00Z"), "UTC")).toBe(false);
    expect(isCalendarEventEnded(event, Date.parse("2026-11-01T09:30:00Z"), "UTC")).toBe(true);
  });

  it("keeps milliseconds when an offset-free end includes them", () => {
    const event = { end: { dateTime: "2026-10-23T10:00:00.500", timeZone: "UTC" } };
    expect(isCalendarEventEnded(event, Date.parse("2026-10-23T10:00:00Z"), "UTC")).toBe(false);
    expect(isCalendarEventEnded(event, Date.parse("2026-10-23T10:00:00.500Z"), "UTC")).toBe(true);
  });

  it("uses the exclusive all-day end in the source calendar timezone", () => {
    const event = { end: { date: "2026-10-23" }, source_time_zone: "Asia/Kolkata" };
    expect(isCalendarEventEnded(event, Date.parse("2026-10-22T18:29:59Z"), "America/Los_Angeles")).toBe(false);
    expect(isCalendarEventEnded(event, Date.parse("2026-10-22T18:30:00Z"), "America/Los_Angeles")).toBe(true);
  });

  it("leaves missing or invalid end times unclassified", () => {
    const now = Date.parse("2026-10-23T00:00:00Z");
    expect(isCalendarEventEnded({ end: null }, now, "UTC")).toBe(false);
    expect(isCalendarEventEnded({ end: { dateTime: "invalid" } }, now, "UTC")).toBe(false);
    expect(isCalendarEventEnded({ end: { date: "2026-02-30" } }, now, "UTC")).toBe(false);
  });
});
