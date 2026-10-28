/** Prefer the current tzdb name when a browser returns its older alias. */
export function calendarTimeZone(value: string | null | undefined): string {
  const zone = value?.trim() || "UTC";
  return zone === "Asia/Calcutta" ? "Asia/Kolkata" : zone;
}
