import type { Meeting } from "@/lib/services/calendar-insights-service";

export const limitationText: Record<string, string> = {
  permission_required: "Allow recording and notes access for this Google account.",
  resource_denied: "Google denied access to an exact linked file. Check its sharing or organization policy.",
  meet_discovery_denied: "Google denied the Meet discovery check. Whether a recording or notes exist is unknown.",
  account_mismatch: "The selected Google account no longer matches this meeting grant. Refresh the account.",
  provider_configuration: "Google's meeting-file service is not available for this connection. Check the provider configuration.",
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

function meetingStatus(meeting: Meeting): string {
  switch (meeting.file_state) {
    case "upcoming": return "Meeting has not finished.";
    case "in_progress": return "Meeting in progress.";
    case "processing": return "Google is processing meeting files.";
    case "access_required": return "Access required. Ask the organizer for the missing file.";
    case "permission_required": return "Allow meeting-file access for this Google account.";
    case "provider_configuration": return "Meeting-file provider setup needs attention.";
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
