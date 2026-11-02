import { bookingInstant } from "./calendar-booking-time";

/**
 * Browsers still report retired tzdb names. Keep this list identical to
 * `LEGACY_TIME_ZONES` in consent-protocol `calendar_time_zone.py`; offsets and
 * daylight-saving rules always come from the zone itself, never a fixed offset.
 */
const LEGACY_TIME_ZONES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Dacca": "Asia/Dhaka",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "Pacific/Enderbury": "Pacific/Kanton",
};

/** Prefer the current tzdb name when a browser returns its older alias. */
export function calendarTimeZone(value: string | null | undefined): string {
  const zone = value?.trim() || "UTC";
  return LEGACY_TIME_ZONES[zone] ?? zone;
}

/** Show the selected instant's UTC offset while retaining the zone for DST math. */
export function calendarTimeZoneOffset(value: string | null | undefined, instant: string | number = Date.now()): string {
  const zone = calendarTimeZone(value);
  try {
    const date = new Date(instant);
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(date).find(part => part.type === "timeZoneName")?.value;
    return name && name !== "GMT" ? name.replace(/^GMT/, "UTC") : "UTC+00:00";
  } catch {
    return "Time zone unavailable";
  }
}

export function calendarTimeZoneOffsetRange(value: string | null | undefined, start: string | number, end: string | number): string {
  const first = calendarTimeZoneOffset(value, start);
  const last = calendarTimeZoneOffset(value, end);
  return first === last ? first : `${first} → ${last}`;
}

function firstInstantOnOrAfterLocalDate(formatter: Intl.DateTimeFormat, date: string, low: number, high: number): number {
  const localDate = (instant: number) => {
    const parts = formatter.formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value || "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(middle) < date) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** A civil day may contain two UTC offsets when daylight saving changes. */
export function calendarTimeZoneDayOffset(value: string | null | undefined, date: string): string {
  const zone = calendarTimeZone(value);
  try {
    const utcMidnight = Date.parse(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(utcMidnight)) throw new Error("Invalid date");
    const nextDate = new Date(utcMidnight + 86_400_000).toISOString().slice(0, 10);
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    });
    // Search UTC instants for the actual civil-day edges. Local 00:00 and
    // 23:59 themselves can be skipped or repeated at a DST transition.
    const start = firstInstantOnOrAfterLocalDate(formatter, date, utcMidnight - 86_400_000, utcMidnight + 86_400_000);
    const end = firstInstantOnOrAfterLocalDate(formatter, nextDate, utcMidnight, utcMidnight + 172_800_000) - 1;
    if (start > end) throw new Error("Skipped date");
    return calendarTimeZoneOffsetRange(zone, start, end);
  } catch {
    return `${calendarTimeZoneChoiceLabel(zone, `${date}T12:00:00Z`).split(" (")[0]} local time`;
  }
}

export function calendarTimeZoneDayLabel(value: string | null | undefined, date: string): string {
  const zone = calendarTimeZone(value);
  const offset = calendarTimeZoneDayOffset(zone, date);
  if (zone === "UTC" || offset.endsWith("local time")) return offset;
  const city = zone.split("/").at(-1)?.replaceAll("_", " ") || "Local time";
  return `${city} (${offset})`;
}

/** Labels for native selectors never expose raw IANA paths to the person. */
export function calendarTimeZoneChoiceLabel(zone: string, instant: string | number = Date.now()): string {
  const normalized = calendarTimeZone(zone);
  const offset = calendarTimeZoneOffset(normalized, instant);
  if (normalized === "UTC") return offset;
  const city = normalized.split("/").at(-1)?.replaceAll("_", " ") || "Local time";
  return `${city} (${offset})`;
}

/** Match the option's offset to the selected wall time in that option's zone. */
export function calendarTimeZoneChoiceLabelForWallTime(zone: string, date: string, time: string): string {
  try { return calendarTimeZoneChoiceLabel(zone, bookingInstant(date, time, zone)); }
  catch { return `${calendarTimeZone(zone).split("/").at(-1)?.replaceAll("_", " ") || "Local time"} (choose another time)`; }
}

export function calendarTimeZoneChoices(current: string): string[] {
  const common = ["UTC", "Asia/Kolkata", "America/New_York", "America/Los_Angeles", "Europe/London"];
  const supported = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set([calendarTimeZone(current), ...common, ...supported.map(calendarTimeZone)])];
}
