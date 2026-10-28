import { describe, expect, it } from "vitest";
import { bookingDefaultDuration, bookingInstant, bookingLocalFields } from "@/lib/calendar/calendar-booking-time";
import { calendarTimeZone } from "@/lib/calendar/calendar-time-zone";

describe("Calendar booking time", () => {
  it("uses the current tzdb identifier even when the browser returns its older alias", () => {
    expect(calendarTimeZone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(calendarTimeZone("America/New_York")).toBe("America/New_York");
  });
  it("uses one hour within a long opening and a shorter supported duration near midnight", () => {
    expect(bookingDefaultDuration({ start_at: "2030-10-21T04:12:00Z", end_at: "2030-10-21T23:00:00Z" })).toBe(60);
    expect(bookingDefaultDuration({ start_at: "2030-10-21T23:30:00Z", end_at: "2030-10-22T00:00:00Z" })).toBe(30);
    expect(bookingDefaultDuration({ start_at: "2030-10-21T23:45:00Z", end_at: "2030-10-22T00:00:00Z" })).toBe(15);
  });

  it("preserves the selected civil date across midnight and non-hour offsets", () => {
    expect(bookingLocalFields("2030-10-21T18:30:00Z", "Asia/Kolkata")).toEqual({ date: "2030-10-22", time: "00:00" });
    expect(bookingInstant("2030-10-22", "00:00", "Asia/Kolkata")).toBe("2030-10-21T18:30:00.000Z");
    expect(bookingInstant("2030-10-22", "09:15", "Asia/Kathmandu")).toBe("2030-10-22T03:30:00.000Z");
  });

  it("refuses skipped and repeated DST times rather than moving the meeting", () => {
    expect(() => bookingInstant("2026-03-08", "02:30", "America/New_York")).toThrow(/skipped or repeated/);
    expect(() => bookingInstant("2026-11-01", "01:30", "America/New_York")).toThrow(/skipped or repeated/);
    expect(bookingInstant("2026-11-01", "03:30", "America/New_York")).toBe("2026-11-01T08:30:00.000Z");
  });
});
