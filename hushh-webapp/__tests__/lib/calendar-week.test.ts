import { afterEach, describe, expect, it } from "vitest";

import {
  buildCalendarWeek,
  msUntilNextLocalMidnight,
  WEEKDAY_LABELS,
} from "@/components/calendar/calendar-week";

function summarize(now: Date) {
  const week = buildCalendarWeek(now);
  const today = week.days.findIndex((day) => day.isToday);
  return {
    heading: week.heading,
    dates: week.days.map((day) => day.date),
    today,
    todayDate: week.days[today]?.date,
    todayCount: week.days.filter((day) => day.isToday).length,
  };
}

describe("buildCalendarWeek", () => {
  it("keeps the weekday labels fixed Sunday-first", () => {
    expect([...WEEKDAY_LABELS]).toEqual(["S", "M", "T", "W", "T", "F", "S"]);
  });

  it.each([
    // [local date, heading, dates, highlighted column]
    [new Date(2026, 9, 30, 9), "October 2026", [25, 26, 27, 28, 29, 30, 31], 5],
    [new Date(2026, 9, 31, 9), "October 2026", [25, 26, 27, 28, 29, 30, 31], 6],
    [new Date(2026, 10, 1, 9), "November 2026", [1, 2, 3, 4, 5, 6, 7], 0],
    [new Date(2026, 10, 2, 9), "November 2026", [1, 2, 3, 4, 5, 6, 7], 1],
    [new Date(2027, 0, 1, 9), "January 2027", [27, 28, 29, 30, 31, 1, 2], 5],
  ])("%s", (now, heading, dates, column) => {
    expect(summarize(now)).toMatchObject({
      heading,
      dates,
      today: column,
      todayCount: 1,
    });
  });

  it("derives the heading from today when the week spans two months", () => {
    // 27 Dec - 2 Jan spans two months and two years; the heading follows today.
    const dec = summarize(new Date(2026, 11, 31, 8));
    expect(dec).toMatchObject({
      heading: "December 2026",
      dates: [27, 28, 29, 30, 31, 1, 2],
      today: 4,
    });
    const jan = summarize(new Date(2027, 0, 2, 8));
    expect(jan).toMatchObject({
      heading: "January 2027",
      dates: [27, 28, 29, 30, 31, 1, 2],
      today: 6,
    });
  });

  it("handles leap-year February into March", () => {
    expect(summarize(new Date(2028, 1, 29, 12))).toMatchObject({
      heading: "February 2028",
      dates: [27, 28, 29, 1, 2, 3, 4],
      today: 2,
    });
    expect(summarize(new Date(2028, 2, 1, 12))).toMatchObject({
      heading: "March 2028",
      dates: [27, 28, 29, 1, 2, 3, 4],
      today: 3,
    });
  });

  it("handles a non-leap February into March", () => {
    expect(summarize(new Date(2027, 2, 1, 12))).toMatchObject({
      heading: "March 2027",
      dates: [28, 1, 2, 3, 4, 5, 6],
      today: 1,
    });
  });

  it("gives every day of the week a unique id across a year change", () => {
    const ids = buildCalendarWeek(new Date(2026, 11, 31)).days.map((d) => d.id);
    expect(new Set(ids).size).toBe(7);
    expect(ids).toEqual([
      "2026-12-27",
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-1-1",
      "2027-1-2",
    ]);
  });
});

describe("local time zone handling", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it.each([
    // Local calendar day differs from the UTC day in each case.
    ["Asia/Kolkata", "2026-11-01T00:30:00+05:30", "November 2026", 1, 0],
    ["America/Los_Angeles", "2026-10-31T23:30:00-07:00", "October 2026", 31, 6],
    ["Pacific/Kiritimati", "2026-11-01T00:30:00+14:00", "November 2026", 1, 0],
    ["Pacific/Pago_Pago", "2026-10-31T23:10:00-11:00", "October 2026", 31, 6],
  ])("%s: %s uses the local day, not the UTC day", (tz, instant, heading, date, column) => {
    process.env.TZ = tz;
    const result = summarize(new Date(instant));
    expect(result.heading).toBe(heading);
    expect(result.todayDate).toBe(date);
    expect(result.today).toBe(column);
    // Guard the case itself: the UTC day must differ from the local day.
    expect(new Date(instant).getUTCDate()).not.toBe(date);
  });
});

describe("msUntilNextLocalMidnight", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("counts to the next local midnight", () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 9, 31, 23, 59, 30))).toBe(30_000);
    expect(msUntilNextLocalMidnight(new Date(2026, 9, 31, 0, 0, 0))).toBe(86_400_000);
  });

  it("follows the calendar on a 25-hour daylight-saving day", () => {
    process.env.TZ = "America/New_York";
    // 1 Nov 2026 clocks go back: the local day is 25 hours long.
    const start = new Date(2026, 10, 1, 0, 30);
    expect(msUntilNextLocalMidnight(start)).toBe(24.5 * 3_600_000);
  });

  it("follows the calendar on a 23-hour daylight-saving day", () => {
    process.env.TZ = "America/New_York";
    // 8 Mar 2026 clocks go forward: the local day is 23 hours long.
    const start = new Date(2026, 2, 8, 0, 30);
    expect(msUntilNextLocalMidnight(start)).toBe(22.5 * 3_600_000);
  });
});
