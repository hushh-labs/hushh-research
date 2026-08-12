import {
  getSessionItem,
  removeSessionItem,
  setSessionItem,
} from "@/lib/utils/session-storage";

const CALENDAR_SETUP_RETURN_KEY = "one_calendar_oauth_setup_return_v1";

/** Store only the redacted callback destination, never OAuth state or tokens. */
export function markCalendarSetupOAuthReturn(): void {
  setSessionItem(CALENDAR_SETUP_RETURN_KEY, "1");
}

export function clearCalendarSetupOAuthReturn(): void {
  removeSessionItem(CALENDAR_SETUP_RETURN_KEY);
}

/** Consume the one-browser setup continuation after the callback settles. */
export function consumeCalendarSetupOAuthReturn(): boolean {
  const shouldReturnToSetup = getSessionItem(CALENDAR_SETUP_RETURN_KEY) === "1";
  removeSessionItem(CALENDAR_SETUP_RETURN_KEY);
  return shouldReturnToSetup;
}
