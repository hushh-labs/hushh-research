import type { Meeting } from "@/lib/services/calendar-insights-service";

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
