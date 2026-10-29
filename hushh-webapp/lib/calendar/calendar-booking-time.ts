/** Calendar booking uses the selected IANA zone, including strict DST boundaries. */
function parts(value: number, timeZone: string) {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(value);
  const field = (name: string) => Number(values.find(part => part.type === name)?.value);
  return { year: field("year"), month: field("month"), day: field("day"), hour: field("hour"), minute: field("minute") };
}

export function bookingLocalFields(instant: string, timeZone: string) {
  const value = parts(Date.parse(instant), timeZone);
  return {
    date: `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`,
    time: `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`,
  };
}

/** Refuse skipped or repeated wall times instead of silently moving the booking. */
export function bookingInstant(date: string, time: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("Choose a valid date and start time.");
  }
  const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7)), day = Number(date.slice(8, 10));
  const hour = Number(time.slice(0, 2)), minute = Number(time.slice(3, 5));
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== `${date}T${time}`) {
    throw new Error("Choose a valid date and start time.");
  }
  try {
    const offsets = new Set<number>();
    for (const probe of [wall - 86_400_000, wall, wall + 86_400_000]) {
      const local = parts(probe, timeZone);
      offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - Math.floor(probe / 60_000) * 60_000);
    }
    const matches = [...offsets].map(offset => wall - offset).filter(candidate => {
      const local = parts(candidate, timeZone);
      return local.year === year && local.month === month && local.day === day && local.hour === hour && local.minute === minute;
    });
    if (matches.length !== 1) throw new Error("This time is skipped or repeated by daylight saving. Choose another start time.");
    return new Date(matches[0]!).toISOString();
  } catch (error) {
    if (error instanceof RangeError) throw new Error("Choose a valid time zone.");
    throw error;
  }
}

export function bookingDefaultDuration(opening: { start_at: string; end_at: string }): 15 | 30 | 60 {
  const minutes = (Date.parse(opening.end_at) - Date.parse(opening.start_at)) / 60_000;
  return minutes >= 60 ? 60 : minutes >= 30 ? 30 : 15;
}
