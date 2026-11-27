export function safeMeetingUrl(value: string | null | undefined): string | null {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** The event's Calendar account hint and Google's account chooser share one
 * target builder across authored links and native action callbacks. */
export function calendarMeetingTarget(value: string | null | undefined, accountEmail?: string | null): { url: string; accountEmail: string; chooserUrl?: string } | null {
  const safe = safeMeetingUrl(value);
  if (!safe) return null;
  const meeting = new URL(safe), email = accountEmail?.trim() || "";
  if (meeting.origin !== "https://meet.google.com" || !email) return { url: safe, accountEmail: "" };
  meeting.searchParams.set("authuser", email);
  const continuation = new URL(meeting);
  continuation.searchParams.delete("authuser");
  const chooser = new URL("https://accounts.google.com/AccountChooser");
  chooser.searchParams.set("continue", continuation.href);
  return { url: meeting.href, accountEmail: email, chooserUrl: chooser.href };
}
