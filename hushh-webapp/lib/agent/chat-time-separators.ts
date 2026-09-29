/**
 * Centered time separators for the One transcript.
 *
 * A separator sits above the first item of each time group instead of a stamp
 * under every bubble. Only real times are used: a live message's send moment,
 * a restored row's `created_at`, or when an onboarding turn was first shown.
 * An item without a time never opens a group and never invents one; the
 * exception is the very first item, which may show the label it already had.
 */

/**
 * Reads a chat time from the backend. ADK session and event times are epoch
 * seconds (floats, or numeric strings); ISO strings and epoch milliseconds are
 * accepted too. `Date.parse` on an epoch-seconds value is NaN, which once
 * dated every history row as unknown ("Older", no time).
 */
export function parseChatTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value
    : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : null;
  const date = numeric !== null
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A new group starts after this much quiet between two timed items. */
export const CHAT_TIME_GROUP_GAP_MS = 30 * 60 * 1000;

export type ChatTimelineItem = {
  id: string;
  /** Epoch ms, when known. */
  atMs?: number | null;
  /** The label the item was already stamped with, used only without a time. */
  label?: string | null;
};

export type ChatTimeSeparator = {
  /** Visible text, e.g. "Today, 9:23 PM" or "25 Sept, 19:50". */
  text: string;
  /** Full, unambiguous reading for assistive tech and the tooltip. */
  accessibleLabel: string;
  /** ISO string for `<time dateTime>`, when the time is known. */
  dateTime?: string;
};

function isTime(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function calendarDayDelta(ms: number, nowMs: number): number {
  // Round, not floor: a DST shift makes a calendar day 23 or 25 hours long.
  return Math.round((startOfDay(nowMs) - startOfDay(ms)) / 86_400_000);
}

function capitalize(text: string): string {
  return text ? `${text.slice(0, 1).toLocaleUpperCase()}${text.slice(1)}` : text;
}

/** Locale- and timezone-aware separator text for a known time. */
export function formatChatTimeSeparator(
  ms: number,
  nowMs: number = Date.now(),
  locale?: string,
): ChatTimeSeparator {
  const date = new Date(ms);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
  const delta = calendarDayDelta(ms, nowMs);
  let day: string;
  if (delta === 0 || delta === 1) {
    day = capitalize(
      new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-delta, "day"),
    );
  } else {
    const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
    day = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      ...(sameYear ? {} : { year: "numeric" }),
    }).format(date);
  }
  const full = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }).format(date);
  return {
    text: `${day}, ${time}`,
    accessibleLabel: `Messages from ${full}`,
    dateTime: date.toISOString(),
  };
}

/**
 * Which items open a time group, keyed by item id.
 *
 * Rules: the first timed item opens a group; a later timed item opens one when
 * it falls on another calendar day than the previous timed item, or at least
 * `CHAT_TIME_GROUP_GAP_MS` after it. Untimed items join the current group.
 */
export function computeChatTimeSeparators(
  items: readonly ChatTimelineItem[],
  nowMs: number = Date.now(),
  locale?: string,
): Map<string, ChatTimeSeparator> {
  const separators = new Map<string, ChatTimeSeparator>();
  let previousMs: number | null = null;
  items.forEach((item, index) => {
    if (!isTime(item.atMs)) {
      const label = item.label?.trim();
      if (index === 0 && label) {
        separators.set(item.id, { text: label, accessibleLabel: `Messages from ${label}` });
      }
      return;
    }
    const opensGroup =
      previousMs === null ||
      startOfDay(item.atMs) !== startOfDay(previousMs) ||
      item.atMs - previousMs >= CHAT_TIME_GROUP_GAP_MS;
    if (opensGroup && !separators.has(item.id)) {
      separators.set(item.id, formatChatTimeSeparator(item.atMs, nowMs, locale));
    }
    previousMs = item.atMs;
  });
  return separators;
}
