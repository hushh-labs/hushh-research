/**
 * What the Overview says for each outcome. One place, so the same failure is
 * never worded two ways, and a failed read is never worded as an empty inbox.
 */

import type { MailOverviewError } from "@/lib/mail/mail-overview-client";

export type MailFailureAction = "retry" | "reconnect" | "unlock" | null;

export type MailFailureCopy = {
  message: string;
  action: MailFailureAction;
};

/** Reading a list or a message. `kept` is true when earlier rows are still shown. */
export function mailReadFailureCopy(
  error: MailOverviewError,
  options: { kept?: boolean } = {},
): MailFailureCopy {
  switch (error.reason) {
    case "auth_missing":
      return { message: "Unlock your vault to see your mail.", action: "unlock" };
    case "connect_required":
      return { message: "Connect your mail.", action: "reconnect" };
    case "reconnect_required":
      return {
        message: "Your mail connection needs attention. Reconnect to continue.",
        action: "reconnect",
      };
    case "account_changed":
      return {
        message: "Your mail account changed. Try again to see the new one.",
        action: "retry",
      };
    case "unavailable":
      return { message: "Mail isn't available for this account.", action: null };
    case "private_runtime":
      return {
        message:
          error.serverMessage ?? "Your agent runs privately. Open it directly to continue.",
        action: null,
      };
    case "source_unavailable":
    case "source_invalid":
      return {
        message: "That email can't be opened. It may have been deleted or moved.",
        action: null,
      };
    case "too_large":
      return { message: "That email is too large to show here.", action: null };
    default:
      return {
        message: options.kept
          ? "Couldn't refresh your mail. Showing what we loaded earlier."
          : "Couldn't load your mail. Try again.",
        action: "retry",
      };
  }
}

/** Preparing a reply. The server's own words explain why an email cannot be answered. */
export function mailReplyFailureCopy(error: MailOverviewError): MailFailureCopy {
  switch (error.reason) {
    case "reply_not_possible":
      return {
        message: error.serverMessage ?? "That email can't be replied to from here.",
        action: null,
      };
    case "reply_unavailable":
      return { message: "Replying from One is switched off.", action: null };
    case "source_unavailable":
    case "source_invalid":
      return {
        message: "That email can't be found now, so it can't be replied to.",
        action: null,
      };
    case "account_changed":
      return {
        message: "Your mail account changed. Go back and open the email again.",
        action: null,
      };
    case "auth_missing":
    case "connect_required":
    case "reconnect_required":
      return mailReadFailureCopy(error);
    default:
      return { message: "Couldn't prepare the reply. Try again.", action: "retry" };
  }
}

/**
 * A received time for a row: the clock time today, a short date this year,
 * and the year after that. Local to the device; the source instant is unchanged.
 */
export function formatMailTime(
  iso: string | null,
  now: Date = new Date(),
  locale?: string,
): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/** The full date and time, for an opened message and the row's tooltip. */
export function formatMailMoment(
  iso: string | null,
  locale?: string,
): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

/** When the list on screen was read, as a clock time on this device. Null before any read. */
export function formatUpdatedTime(fetchedAtMs: number, locale?: string): string | null {
  if (!fetchedAtMs || !Number.isFinite(fetchedAtMs)) return null;
  return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(fetchedAtMs));
}

/** Reading the brief. A failed or slow check is never worded as "nothing needs you". */
export function mailBriefFailureCopy(
  error: MailOverviewError,
  options: { kept?: boolean } = {},
): MailFailureCopy {
  switch (error.reason) {
    case "brief_unavailable":
      return {
        message: options.kept
          ? "Couldn't refresh. Showing what One found earlier."
          : "One couldn't check your mail just now. Try again.",
        action: "retry",
      };
    case "brief_busy":
      return {
        message: "One is already checking your mail. Try again in a moment.",
        action: "retry",
      };
    default:
      return mailReadFailureCopy(error, options);
  }
}

/** A message's day as the brief shows it, e.g. "20 Nov 2026". Fixed like Receipts' dates, so the two never differ. */
export function formatEvidenceDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

/** When a confirmed send happened, e.g. "22 Nov 2026 · 9:38 AM", in the viewer's own time zone. */
export function formatSentStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
  return `${day} · ${time}`;
}
