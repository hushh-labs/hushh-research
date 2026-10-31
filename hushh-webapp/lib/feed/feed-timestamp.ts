import { formatLocalDateTime } from "@/lib/utils/local-date-time";

/**
 * Local-midnight day offset of `date` from `now`: 0 = today, 1 = yesterday,
 * 2+ = older, negative = future. Shared by every Today/Yesterday
 * classification in the feed so the calendar-day arithmetic exists in
 * exactly one place.
 */
export function daysSinceToday(date: Date, now: Date = new Date()): number {
  const startOfDay = (input: Date) =>
    new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  return Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
}

/**
 * Renders a feed row's local time only. The section header already owns the
 * calendar day, so repeating "Today" or "Yesterday" on every row adds noise.
 * Always a two-digit 12-hour clock so the timestamp column stays stable.
 */
export function formatFeedTimestamp(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const label =
    formatLocalDateTime(date, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }) || "";
  return label.replace(/\b(am|pm)\b/iu, (meridiem) =>
    meridiem.toUpperCase(),
  );
}
