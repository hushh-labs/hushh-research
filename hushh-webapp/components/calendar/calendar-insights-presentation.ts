import { meetingFilesPhrase, notAvailableMessage } from "@/lib/calendar/meeting-file-copy";
import type { Meeting, MeetingFileKind, MeetingRequestOutcome, VerifiedMeetingSelection } from "@/lib/services/calendar-insights-service";

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
};

/** Limitations that describe how the check works, not something the person can act on. */
const SILENT_LIMITATIONS: ReadonlySet<string> = new Set(["attendee_discovery_limited"]);
export function visibleLimitation(limitations: readonly string[] | undefined): string | null {
  const shown = (limitations || []).find(item => !SILENT_LIMITATIONS.has(item));
  return shown === undefined ? null : limitationText[shown] || "Some meeting files could not be checked.";
}

export type RequestRecovery = {
  /** "terminal": repeating the request cannot succeed. "retry": it may. */
  tone: "terminal" | "retry";
  message: string;
  copy: boolean;
};

/** Shown once, quietly, below Ask organizer, and only to someone who is not connected. It is a link to Connect. */
export const NOT_CONNECTED_HINT = "Requests work once you're connected on One.";
export const PENDING_CONNECTION_TEXT = "Waiting for connection approval.";
export const UNVERIFIED_ORGANIZER_RECOVERY: RequestRecovery = {
  tone: "terminal", copy: false,
  message: "One can't confirm who this organizer is right now, so it can't send the request. Ask the organizer directly.",
};

type RequestFailure = { status?: number; code?: string; reason?: string; message?: string } | null;

/** The server refused because the requester is not connected to the verified organizer. */
export function isConnectionRefusal(failure: RequestFailure): boolean {
  return failure?.code === "connection_required" ||
    (failure?.code === "calendar_organizer_unavailable" && failure.reason !== "organizer_missing");
}

/**
 * What to offer after a meeting-file request fails.
 *
 * A refusal that describes the selection (not an attendee, no reachable
 * organizer) cannot be fixed by sending the same request again, so it never keeps
 * a Send action. Only failures that did not finish (a lookup or network problem)
 * stay retryable.
 */
export function requestRecovery(failure: RequestFailure): RequestRecovery {
  const code = failure?.code;
  const reason = failure?.reason;
  const terminal = (message: string, actions: Partial<Omit<RequestRecovery, "tone" | "message">> = {}): RequestRecovery =>
    ({ tone: "terminal", message, copy: false, ...actions });
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
  if (code === "calendar_organizer_unavailable" && reason === "organizer_missing")
    return terminal("This meeting has no organizer One can reach. Copy your request and send it directly.", { copy: true });
  // A connection refusal never reaches here: callers read it with isConnectionRefusal and show the quiet hint.
  if (isConnectionRefusal(failure)) return terminal(NOT_CONNECTED_HINT);
  const message = failure?.message || "Meeting request could not be sent.";
  // `sharing_unavailable` is a service-level condition: retry, or reach out directly.
  return { tone: "retry", message, copy: code === "sharing_unavailable" };
}

function meetingStatus(meeting: Meeting): string {
  switch (meeting.file_state) {
    case "upcoming": return "Meeting has not finished.";
    case "in_progress": return "Meeting in progress.";
    case "processing": return "Google is processing meeting files.";
    case "access_required": return "Not available yet. Ask the organizer for access.";
    case "permission_required": return "Allow meeting-file access for this Google account.";
    case "provider_configuration": return "Meeting-file service isn't enabled yet. Retrying won't help.";
    case "provider_policy": return "Your Google organization restricts this file check.";
    case "account_mismatch": return "The selected Google account changed. Refresh it.";
    case "temporarily_unavailable": return "File check failed. Retry.";
    case "available": return "Verified file access.";
    default: return "Not available yet.";
  }
}

export function focusedStatus(meeting: Meeting, filter: "all" | "recording" | "notes"): string {
  if (meeting.discovery === "meet_discovery_denied" && !meeting.artifact_kinds.length)
    return "Meet didn't allow this check, so files may exist. You can ask the organizer.";
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

const kindsText = (kinds: readonly MeetingFileKind[]) => meetingFilesPhrase(kinds, "or");
const LIVE_STATUSES = ["pending", "preparing", "review_ready", "approved", "completed", "partial"];

/** What the organizer has said they do not have, across every request for the meeting. */
export function notAvailableKinds(outcome: MeetingRequestOutcome | undefined): MeetingFileKind[] {
  const said = new Set((outcome?.requests || []).flatMap(item => item.notAvailableTypes || []));
  return (["recording", "notes"] as const).filter(kind => said.has(kind));
}

/** Types already asked for (open or fulfilled) or answered, so Ask organizer offers only what is still outstanding. */
export function askedKinds(outcome: MeetingRequestOutcome | undefined): MeetingFileKind[] {
  const asked = new Set<MeetingFileKind>(notAvailableKinds(outcome));
  for (const item of outcome?.requests || []) if (LIVE_STATUSES.includes(item.status)) item.requestedTypes.forEach(kind => asked.add(kind));
  return (["recording", "notes"] as const).filter(kind => asked.has(kind));
}

export { notAvailableMessage };

/**
 * The requester's one-line view of a request: Request sent, Checking access, then
 * the files appear as Available. Only the requester's own selected account can
 * make a file Available, and an organizer's "Don't have" is reported as exactly
 * that, never as proof that a file does not exist.
 */
export function requestStatusText(outcome: MeetingRequestOutcome | undefined, hasFiles: boolean, checksExhausted: boolean): string | null {
  if (outcome?.status === "unverified")
    return "This meeting's request status could not be verified. Refresh to try again.";
  const requests = outcome?.requests || [];
  if (!requests.length) return null;
  const has = (...statuses: string[]) => requests.some(item => statuses.includes(item.status));
  if (requests.some(item => item.identityStatus === "unverified"))
    return "The selected Google account changed. Reconnect it to verify access.";
  const missing = notAvailableKinds(outcome);
  const parts: string[] = missing.length ? [notAvailableMessage(missing)] : [];
  const open = Array.from(new Set(requests.filter(item => ["pending", "preparing", "review_ready"].includes(item.status))
    .flatMap(item => item.requestedTypes))).filter(kind => !missing.includes(kind));
  if (open.length) parts.push(missing.length ? `Request sent for the ${kindsText(open)}. Waiting for organizer.` : "Request sent · Waiting for organizer");
  if (has("approved") && !hasFiles) parts.push("Checking access…");
  else if (has("completed") && !hasFiles)
    parts.push(checksExhausted ? "Sharing finished, but this account's access isn't verified yet." : "Checking access…");
  if (has("partial"))
    parts.push(hasFiles ? "Some files are available; others could not be shared or verified." :
      "Only part of this request was shared; no file access is verified for this account.");
  if (has("failed", "no_match")) parts.push("Sharing did not complete. Ask the organizer to review again.");
  if (!missing.length && has("declined") && !parts.length) parts.push("The organizer declined this request.");
  return parts.length ? parts.join(" ") : null;
}
