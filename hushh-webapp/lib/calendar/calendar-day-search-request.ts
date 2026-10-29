import { calendarTimeZoneDayLabel } from "./calendar-time-zone";

/** The Calendar-generated request needs its exact zone for local-day searches. */
export function calendarDaySearchRequest(date: string, zone: string, duration: number): string {
  return `Calendar request: Help me find a different time on ${date} in ${calendarTimeZoneDayLabel(zone, date)} for a ${duration}-minute meeting. Check the full selected local day.`;
}

/** Recognize only our own request shape when restored history has lost turn metadata. */
export function isCalendarDaySearchRequest(text: string): boolean {
  return /^Calendar request: Help me find a different time on \d{4}-\d{2}-\d{2} in .+ for a (?:15|30|60)-minute meeting\. Check the full selected local day\.$/.test(text.trim());
}
