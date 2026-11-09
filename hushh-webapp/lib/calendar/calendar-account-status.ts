import type { GoogleCalendarStatus } from "@/lib/services/google-calendar-service";

/** An account inventory is authoritative; its absence supports legacy default only. */
export function calendarAccountStatus(status: GoogleCalendarStatus, accountId = "default") {
  if (Array.isArray(status.accounts)) {
    return status.accounts.find(account => account.account_id === accountId) ?? null;
  }
  return accountId === "default" ? status : null;
}

/** Missing IDs support legacy default cards; explicit malformed IDs never do. */
export function calendarDirectiveAccountId(payload: Record<string, unknown>): string | null {
  const value = payload.accountId;
  if (value === undefined) return "default";
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128 ? value : null;
}
