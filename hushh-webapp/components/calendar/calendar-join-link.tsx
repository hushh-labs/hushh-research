"use client";

import type { ReactNode } from "react";
import { safeMeetingUrl } from "@/lib/calendar/calendar-url";

/** Let Google reuse the calendar account's session or handle sign-in itself. */
export function CalendarJoinLink({ url, accountEmail, label = "Join meeting", ariaLabel, className, children }: {
  url: string | null | undefined;
  accountEmail?: string | null;
  label?: string;
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  const safe = safeMeetingUrl(url);
  if (!safe) return null;
  const meeting = new URL(safe);
  const email = accountEmail?.trim() || "";
  let href = safe;
  if (meeting.origin === "https://meet.google.com" && email) {
    meeting.searchParams.set("authuser", email);
    // Meet alone can fall back to the default session when this account is absent.
    // Google's account handoff skips its chooser when the hinted session exists.
    const account = new URL("https://accounts.google.com/AccountChooser");
    account.searchParams.set("Email", email);
    account.searchParams.set("continue", meeting.href);
    href = account.href;
  }
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className} aria-label={ariaLabel}>{children || label}</a>;
}
