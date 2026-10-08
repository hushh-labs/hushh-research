const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function calendarReminderId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value)
    ? value.toLowerCase()
    : null;
}
export function calendarReminderHref(value: unknown): string | null {
  const id = calendarReminderId(value);
  return id ? `/one/feed?calendarReminder=${id}` : null;
}
export function isCalendarReminderTarget(path: string): boolean {
  const url = new URL(path, "https://one.local");
  return (
    url.pathname.replace(/\/$/, "") === "/one/feed" &&
    Boolean(calendarReminderId(url.searchParams.get("calendarReminder")))
  );
}
