import { describe, expect, it } from "vitest";

import { bookingInstant } from "@/lib/calendar/calendar-booking-time";
import { calendarTimeZone } from "@/lib/calendar/calendar-time-zone";

describe("calendar time zones", () => {
  it.each([
    ["Asia/Calcutta", "Asia/Kolkata"],
    ["Europe/Kiev", "Europe/Kyiv"],
    ["Asia/Katmandu", "Asia/Kathmandu"],
    ["America/Buenos_Aires", "America/Argentina/Buenos_Aires"],
    ["America/New_York", "America/New_York"],
    [" ", "UTC"],
    [null, "UTC"],
  ])("maps %s to %s", (given, expected) => expect(calendarTimeZone(given)).toBe(expected));

  it("books the same wall time at the right UTC instant on either side of daylight saving", () => {
    expect(bookingInstant("2026-03-07", "09:00", "America/New_York")).toBe("2026-03-07T14:00:00.000Z");
    expect(bookingInstant("2026-03-09", "09:00", "America/New_York")).toBe("2026-03-09T13:00:00.000Z");
    expect(bookingInstant("2026-10-24", "09:00", "Europe/London")).toBe("2026-10-24T08:00:00.000Z");
    expect(bookingInstant("2026-10-26", "09:00", "Europe/London")).toBe("2026-10-26T09:00:00.000Z");
    expect(bookingInstant("2026-11-02", "09:00", "Asia/Kolkata")).toBe("2026-11-02T03:30:00.000Z");
  });

  it("refuses a time that daylight saving skips or repeats", () => {
    expect(() => bookingInstant("2026-03-08", "02:30", "America/New_York")).toThrow(/skipped or repeated/);
    expect(() => bookingInstant("2026-11-01", "01:30", "America/New_York")).toThrow(/skipped or repeated/);
  });
});
