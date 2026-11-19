/**
 * Pure local-calendar arithmetic for the Calendar connect illustration.
 *
 * Everything here works on the device's local calendar date. Dates are built
 * from year/month/day parts, never from a UTC string (`toISOString`) or a
 * fixed 86,400,000 ms step, so month lengths, leap years, year changes and
 * daylight-saving days all resolve through the platform calendar.
 */

/** Fixed Sunday-first column order; the labels are never rotated. */
export const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"] as const;

export type CalendarWeekDay = {
  /** Local `YYYY-M-D`, unique across month and year boundaries. */
  readonly id: string;
  readonly date: number;
  readonly isToday: boolean;
};

export type CalendarWeek = {
  /** Local `YYYY-M-D` of today; a change means the week view must refresh. */
  readonly dayKey: string;
  /** Month and year of today, e.g. "October 2026". */
  readonly heading: string;
  /** The seven dates of the Sunday-Saturday week containing today. */
  readonly days: readonly CalendarWeekDay[];
};

/** Local calendar-day identity of `date`. */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** The Sunday-Saturday week containing `now`, in the device's local calendar. */
export function buildCalendarWeek(now: Date): CalendarWeek {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const dayKey = localDayKey(now);

  const days = Array.from({ length: 7 }, (_, column): CalendarWeekDay => {
    // `getDay()` is 0 for Sunday, so this walks from that Sunday to Saturday.
    const cell = new Date(year, month, day - now.getDay() + column);
    const id = localDayKey(cell);
    return { id, date: cell.getDate(), isToday: id === dayKey };
  });

  return {
    dayKey,
    // A new formatter per call so a changed device time zone is respected.
    heading: new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
    }).format(now),
    days,
  };
}

/** Milliseconds from `now` to the next local midnight (always positive). */
export function msUntilNextLocalMidnight(now: Date): number {
  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  return Math.max(nextMidnight.getTime() - now.getTime(), 1);
}
