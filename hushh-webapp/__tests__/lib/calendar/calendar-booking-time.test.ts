import { describe, expect, it } from "vitest";
import { bookingDefaultDuration, bookingInstant, bookingLocalFields } from "@/lib/calendar/calendar-booking-time";
import { calendarTimeZone, calendarTimeZoneChoiceLabel, calendarTimeZoneChoiceLabelForWallTime, calendarTimeZoneChoices, calendarTimeZoneDayLabel, calendarTimeZoneDayOffset, calendarTimeZoneOffset, calendarTimeZoneOffsetRange } from "@/lib/calendar/calendar-time-zone";
import { calendarDaySearchRequest, isCalendarDaySearchRequest } from "@/lib/calendar/calendar-day-search-request";

describe("Calendar booking time", () => {
  it("uses the current tzdb identifier even when the browser returns its older alias", () => {
    expect(calendarTimeZone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(calendarTimeZone("America/New_York")).toBe("America/New_York");
  });
  it("shows readable UTC offsets while keeping exact zones for daylight saving", () => {
    expect(calendarTimeZoneOffset("Asia/Calcutta", "2030-10-21T12:00:00Z")).toBe("UTC+05:30");
    expect(calendarTimeZoneChoiceLabel("Asia/Calcutta", "2030-10-21T12:00:00Z")).toBe("Kolkata (UTC+05:30)");
    expect(calendarTimeZoneOffset("America/New_York", "2026-01-01T12:00:00Z")).toBe("UTC-05:00");
    expect(calendarTimeZoneOffset("America/New_York", "2026-07-01T12:00:00Z")).toBe("UTC-04:00");
    expect(calendarTimeZoneChoices("Asia/Calcutta")).toContain("Asia/Kolkata");
  });
  it("labels the selected wall time and both offsets across daylight saving", () => {
    expect(calendarTimeZoneChoiceLabelForWallTime("America/New_York", "2026-03-08", "01:30")).toBe("New York (UTC-05:00)");
    expect(calendarTimeZoneChoiceLabelForWallTime("America/New_York", "2026-03-08", "03:30")).toBe("New York (UTC-04:00)");
    expect(calendarTimeZoneChoiceLabelForWallTime("America/New_York", "2026-03-08", "02:30")).toBe("New York (choose another time)");
    expect(calendarTimeZoneOffsetRange("America/New_York", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z")).toBe("UTC-04:00 → UTC-05:00");
    expect(calendarTimeZoneDayOffset("America/New_York", "2026-03-08")).toBe("UTC-05:00 → UTC-04:00");
    expect(calendarTimeZoneDayLabel("America/New_York", "2026-03-08")).toBe("New York (UTC-05:00 → UTC-04:00)");
    expect(calendarTimeZoneDayOffset("America/New_York", "2026-01-08")).toBe("UTC-05:00");
    expect(calendarTimeZoneDayOffset("America/Santiago", "2026-04-04")).toBe("UTC-03:00 → UTC-04:00");
    expect(calendarTimeZoneDayOffset("America/Santiago", "2026-09-06")).toBe("UTC-03:00");
  });
  it("recognizes only Calendar's generated full-day search request", () => {
    const request = calendarDaySearchRequest("2026-11-01", "America/New_York", 30);
    expect(request).toContain("New York (UTC-04:00 → UTC-05:00)");
    expect(request).not.toContain("America/New_York");
    expect(isCalendarDaySearchRequest(request)).toBe(true);
    expect(isCalendarDaySearchRequest(request.replace(/^Calendar request: /, ""))).toBe(false);
    expect(isCalendarDaySearchRequest("Find another time on November 1 in New York.")).toBe(false);
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
