/** An explicit Calendar handoff applies only to its turn; other turns use the device zone. */
export function browserTimeZone(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; }
  catch { return undefined; }
}

export function chatTurnTimeZone(calendarZone?: string): string | undefined {
  const deviceZone = browserTimeZone();
  if (!calendarZone) return deviceZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: calendarZone }).format();
    return calendarZone;
  } catch {
    return deviceZone;
  }
}
