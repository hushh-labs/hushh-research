import { ROUTES } from "@/lib/navigation/routes";

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^(?:default|[A-Za-z0-9_-]{1,64})$/;

/** A notification is only a pointer; Calendar rechecks the owner and Mail grant. */
export function calendarFollowupHref(accountId: unknown, requestId: unknown): string | null {
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId) ||
      typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return null;
  return `${ROUTES.CALENDAR}?${new URLSearchParams({
    followupAccount: accountId, followupRequest: requestId,
  }).toString()}`;
}

export function calendarFollowupNotificationTapTarget(data: Record<string, unknown> | undefined): string | null {
  if (String(data?.type || "").trim().toLowerCase() !== "calendar_email_follow_up") return null;
  return calendarFollowupHref(data?.account_id, data?.followup_request_id) || ROUTES.CALENDAR;
}
