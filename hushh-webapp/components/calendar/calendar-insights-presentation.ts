import type { Meeting, MeetingRequestOutcome, VerifiedMeetingSelection } from "@/lib/services/calendar-insights-service";

export const limitationText: Record<string, string> = {
  permission_required: "Allow recording and notes access for this Google account.",
  resource_denied: "Google denied access to an exact linked file. Check its sharing or organization policy.",
  meet_discovery_denied: "Google denied the Meet discovery check. Whether a recording or notes exist is unknown.",
  account_mismatch: "The selected Google account no longer matches this meeting grant. Refresh the account.",
  provider_configuration: "Google's meeting-file service isn't enabled for Hushh One yet. Retrying won't help; this needs a setup change on our side.",
  provider_policy: "Your Google organization does not allow this meeting-file check.",
  processing: "Google is still preparing meeting files. Refresh later.",
  temporarily_unavailable: "Google could not finish checking meeting files. Try again.",
  unverified: "A reused meeting link could not be matched to one occurrence.",
  files_incomplete: "Some meeting files could not be checked.",
  calendar_unreadable: "Some subscribed calendars do not share event details.",
  calendar_incomplete: "Calendar returned an incomplete page.",
  request_budget: "More meetings remain to be checked. Continue this day.",
  provider_retention: "Google Meet records for this older day may have expired; coverage cannot be confirmed.",
  attendee_discovery_limited: "An attendee's shared meeting files may be missing from this check.",
};

export type RequestRecovery = {
  /** "terminal": repeating the request cannot succeed. "retry": it may. */
  tone: "terminal" | "retry";
  message: string;
  connect: boolean;
  invite: boolean;
  copy: boolean;
};

const UNREACHABLE_ORGANIZER =
  "The organizer isn't connected to you on One, so this request can't be delivered there. Connect with them or invite them, or copy your request and send it directly.";

/**
 * What to offer after a meeting-file request fails.
 *
 * A refusal that describes the selection (not an attendee, no reachable
 * organizer) cannot be fixed by sending the same request again, so it never keeps
 * a Send action. Only failures that did not finish (a lookup or network problem)
 * stay retryable.
 */
export function requestRecovery(
  failure: { status?: number; code?: string; reason?: string; message?: string } | null,
): RequestRecovery {
  const code = failure?.code;
  const reason = failure?.reason;
  const terminal = (message: string, actions: Partial<Omit<RequestRecovery, "tone" | "message">> = {}): RequestRecovery =>
    ({ tone: "terminal", message, connect: false, invite: false, copy: false, ...actions });
  if (code === "calendar_attendee_required") {
    switch (reason) {
      case "requester_is_organizer":
        return terminal("You organized this meeting, so there is no organizer to ask. Open its files from Google Drive.");
      case "event_cancelled":
        return terminal("This meeting was cancelled, so there are no files to request.");
      case "requester_declined":
        return terminal("You declined this meeting. Accept the invitation in Google Calendar to request its files.");
      default:
        return terminal(
          "The selected Google account isn't verified as an invited attendee of this meeting, so One can't send the request. Ask the organizer directly.",
          { copy: true },
        );
    }
  }
  if (code === "calendar_organizer_unavailable") {
    return reason === "organizer_missing"
      ? terminal("This meeting has no organizer One can reach. Copy your request and send it directly.", { copy: true })
      : terminal(UNREACHABLE_ORGANIZER, { connect: true, invite: true, copy: true });
  }
  if (code === "connection_required") return terminal(UNREACHABLE_ORGANIZER, { connect: true, invite: true, copy: true });
  const message = failure?.message || "Meeting request could not be sent.";
  // `sharing_unavailable` is a service-level condition: retry, or reach out directly.
  return { tone: "retry", message, connect: false, invite: false, copy: code === "sharing_unavailable" };
}

function meetingStatus(meeting: Meeting): string {
  switch (meeting.file_state) {
    case "upcoming": return "Meeting has not finished.";
    case "in_progress": return "Meeting in progress.";
    case "processing": return "Google is processing meeting files.";
    case "access_required": return "Access required. Ask the organizer for the missing file.";
    case "permission_required": return "Allow meeting-file access for this Google account.";
    case "provider_configuration": return "Meeting-file service isn't enabled yet. Retrying won't help.";
    case "provider_policy": return "Your Google organization restricts this file check.";
    case "account_mismatch": return "The selected Google account changed. Refresh it.";
    case "temporarily_unavailable": return "File check failed. Retry.";
    case "available": return "Verified file access.";
    default: return "We couldn’t verify the files—ask the organizer.";
  }
}

export function focusedStatus(meeting: Meeting, filter: "all" | "recording" | "notes"): string {
  if (meeting.discovery === "meet_discovery_denied" && !meeting.artifact_kinds.length)
    return "Meet discovery was denied; file existence is unknown. Ask the organizer.";
  if (filter !== "all" && meeting.artifact_kinds.length && !meeting.artifact_kinds.includes(filter)) {
    const available = meeting.artifact_kinds.includes("notes") ? "Notes" : "Recording";
    return `${filter === "recording" ? "Recording" : "Notes"} access is not verified. ${available} remain available.`;
  }
  return meetingStatus(meeting);
}

export function meetingTime(meeting: Meeting, zone: string): string {
  return meeting.start?.dateTime
    ? new Date(meeting.start.dateTime).toLocaleTimeString(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" })
    : "Time unavailable";
}

/** The verified selection the server checks a meeting against, never a browser-chosen address. */
export function selectionOf(meeting: Meeting, accountId: string, date: string, timeZone: string): VerifiedMeetingSelection {
  return { account_id: accountId, calendar_id: meeting.calendar_id, event_id: meeting.id,
    occurrence_id: meeting.occurrence_id, expected_grant: meeting.grant_id, date, time_zone: timeZone };
}

/** The requester's one-line view of a request: what has happened and what is still being checked. */
export function requestStatusText(outcome: MeetingRequestOutcome | undefined, hasFiles: boolean, checksExhausted: boolean): string | null {
  if (outcome?.status === "unverified")
    return "This meeting's request status could not be verified. Refresh to try again.";
  const requests = outcome?.requests || [];
  if (!requests.length) return null;
  const has = (...statuses: string[]) => requests.some(item => statuses.includes(item.status));
  if (requests.some(item => item.identityStatus === "unverified"))
    return "The selected Google account changed. Reconnect it to verify access.";
  if (has("pending", "preparing", "review_ready")) return "Request sent · waiting for organizer review.";
  if (has("approved") && !hasFiles) return "Sharing · checking access with your selected Google account.";
  if (has("declined")) return "Organizer declined this request.";
  if (has("failed", "no_match")) return "Sharing did not complete. Ask the organizer to review again.";
  if (has("partial"))
    return hasFiles ? "Some files are available; others could not be shared or verified." :
      "Only part of this request was shared; no file access is verified for this account.";
  if (has("completed") && !hasFiles)
    return checksExhausted
      ? "Drive finished sharing, but file access is not currently verified for this account."
      : "Drive finished sharing · checking access with your selected Google account.";
  return null;
}
