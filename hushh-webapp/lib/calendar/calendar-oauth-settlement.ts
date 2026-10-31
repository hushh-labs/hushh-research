"use client";

import { hasCalendarMeetingFileGrant } from "@/lib/google/google-oauth-popup";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { trackEvent } from "@/lib/observability/client";
import { GoogleCalendarService, type GoogleCalendarStatus } from "@/lib/services/google-calendar-service";

type CurrentUser = { getIdToken: () => Promise<string> };

export type UnsettledCalendarPopup = {
  operationOwnerId: string;
  accessLevel: "read" | "manage";
  additional: boolean;
  meetingFiles?: boolean;
  targetAccountId?: string;
  previousAccountIds?: string[];
  expectedSubjectSha256?: string;
  priorGrantGeneration?: string;
  callbackRecorded: boolean;
  expired: boolean;
};

export async function pollCalendarMeetingGrant(input: {
  ownerId: string | null;
  targetAccountId: string;
  expectedSubjectSha256?: string;
  priorGrantGeneration?: string;
  getUser: () => CurrentUser | null;
  isCurrent: () => boolean;
  onVerified: (status: GoogleCalendarStatus) => void;
  /** Called once the original page has reached a final state for this attempt (verified or not). */
  onSettled?: () => void;
}): Promise<void> {
  for (let attemptNumber = 0; attemptNumber < 5; attemptNumber += 1) {
    const user = input.getUser();
    if (!input.isCurrent() || !input.ownerId || !user) return;
    try {
      const idToken = await user.getIdToken();
      if (!input.isCurrent()) return;
      const next = await GoogleCalendarService.status(idToken, input.ownerId);
      if (!input.isCurrent()) return;
      if (hasCalendarMeetingFileGrant(next, input.targetAccountId, input.expectedSubjectSha256, input.priorGrantGeneration)) {
        input.onVerified(next);
        morphyToast.success("Recording and notes access enabled.");
        input.onSettled?.();
        return;
      }
    } catch { /* A later bounded status read may observe the saved grant. */ }
    await new Promise(resolve => window.setTimeout(resolve, 1500));
  }
  if (input.isCurrent()) {
    morphyToast.error("Recording and notes access could not be verified. Refresh before trying again.");
    input.onSettled?.();
  }
}

export async function reconcileUnsettledCalendarPopup(
  input: UnsettledCalendarPopup,
  refresh: () => Promise<GoogleCalendarStatus | null>,
  isCurrent: () => boolean,
): Promise<void> {
  const currentStatus = await refresh().catch(() => null);
  if (!isCurrent()) return;
  if (
    input.meetingFiles && input.targetAccountId && currentStatus &&
    Boolean(input.priorGrantGeneration) && hasCalendarMeetingFileGrant(currentStatus, input.targetAccountId, input.expectedSubjectSha256, input.priorGrantGeneration)
  ) {
    if (!input.callbackRecorded) trackEvent("one_calendar_action", { route_id: "one_calendar", action: "connected", result: "success" });
    morphyToast.success("Recording and notes access enabled.");
    return;
  }
  if (
    !input.targetAccountId && !input.additional && currentStatus?.connected &&
    (input.accessLevel !== "manage" || currentStatus.access_level === "manage")
  ) {
    if (!input.callbackRecorded) trackEvent("one_calendar_action", { route_id: "one_calendar", action: "connected", result: "success" });
    morphyToast.success("Google Calendar connected.");
    return;
  }
  if (
    !input.targetAccountId && input.additional && currentStatus?.accounts?.some(account =>
      account.connected && account.status === "connected" &&
      !input.previousAccountIds?.includes(account.account_id) &&
      (input.accessLevel !== "manage" || account.access_level === "manage"))
  ) {
    if (!input.callbackRecorded) trackEvent("one_calendar_action", { route_id: "one_calendar", action: "connected", result: "success" });
    morphyToast.success("Google Calendar connected.");
    return;
  }
  if (!input.callbackRecorded) {
    trackEvent("one_calendar_action", {
      route_id: "one_calendar",
      action: "connected",
      result: input.expired ? "error" : "expected_error",
    });
  }
  // Cancelling is the person's choice: end quietly. Only expiry explains.
  if (input.expired) {
    morphyToast.error("Calendar connection is taking too long. Check your connection and try again.");
  }
}
