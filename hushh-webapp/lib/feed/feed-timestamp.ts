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
 * Renders a feed row's right-aligned day/time label: "Today - 3:45 PM",
 * "Yesterday - 3:45 PM", or "Mon - 3:45 PM" (short weekday) for anything
 * older. Always a 12-hour clock, explicit regardless of locale default.
 * Returns "" for an invalid/missing instant so callers can embed the result
 * directly in JSX without a null-guard.
 */
export function formatFeedTimestamp(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const time = formatLocalDateTime(date, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  if (!time) return "";
  const diffDays = daysSinceToday(date);
  if (diffDays === 0) return `Today - ${time}`;
  if (diffDays === 1) return `Yesterday - ${time}`;
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  return `${weekday} - ${time}`;
}