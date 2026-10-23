import type { CalendarEventSummary } from "@/lib/services/google-calendar-service";

function civilDateAt(instant: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function offsetFreeEndInstant(value: string, zone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) return null;
  const year = match[1]!, month = match[2]!, day = match[3]!;
  const hour = match[4]!, minute = match[5]!, second = match[6]!;
  const fraction = match[7] || "";
  const target = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second, +(fraction.padEnd(3, "0")));
  const targetDate = new Date(target);
  if (!Number.isFinite(target) || targetDate.toISOString().slice(0, 19) !== `${year}-${month}-${day}T${hour}:${minute}:${second}`) return null;

  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const partsAt = (instant: number): [number, number, number, number, number, number] => {
      const parts = formatter.formatToParts(new Date(instant));
      const part = (type: string) => +(parts.find(value => value.type === type)?.value || NaN);
      return [part("year"), part("month"), part("day"), part("hour"), part("minute"), part("second")];
    };
    const expected = [+year, +month, +day, +hour, +minute, +second];
    const offsets = new Set<number>();
    for (const hours of [-36, -12, 0, 12, 36]) {
      const probe = target + hours * 3_600_000;
      const [y, m, d, h, min, s] = partsAt(probe);
      offsets.add(Date.UTC(y, m - 1, d, h, min, s, new Date(probe).getUTCMilliseconds()) - probe);
    }
    const matches = [...offsets].map(offset => target - offset).filter(instant =>
      partsAt(instant).every((part, index) => part === expected[index]));
    // Repeated wall times at a fall-back transition end at the later instant.
    return matches.length ? Math.max(...matches) : null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** A past time is a display state, separate from Google status and attendance. */
export function isCalendarEventEnded(
  event: Pick<CalendarEventSummary, "end" | "source_time_zone">,
  now: number,
  displayZone: string,
): boolean {
  if (!event.end || !Number.isFinite(now)) return false;

  if (event.end.dateTime) {
    const value = event.end.dateTime;
    const end = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
      ? Date.parse(value)
      : offsetFreeEndInstant(value, event.end.timeZone || event.source_time_zone || displayZone);
    return end !== null && Number.isFinite(end) && now >= end;
  }

  // Google's all-day end is an exclusive civil date in the source calendar.
  const endDate = event.end.date;
  if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return false;
  const parsed = new Date(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== endDate) return false;

  const zone = event.source_time_zone || event.end.timeZone || displayZone;
  try {
    return civilDateAt(now, zone) >= endDate;
  } catch (error) {
    if (!(error instanceof RangeError) || zone === displayZone) return false;
    try { return civilDateAt(now, displayZone) >= endDate; } catch { return false; }
  }
}
