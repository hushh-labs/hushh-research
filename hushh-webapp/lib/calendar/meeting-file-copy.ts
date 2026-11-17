/**
 * The wording for a meeting's recording and notes requests, shared by the
 * Calendar screen, the Feed and the organizer's review so each side of one
 * request says the same thing. It reads only the closed `recording` / `notes`
 * vocabulary, never a title, file name or address.
 */
import type { MeetingFileKind } from "@/lib/services/calendar-insights-service";

const ORDER: readonly MeetingFileKind[] = ["recording", "notes"];

/**
 * The closed file types in a metadata value; anything else is dropped. Feed
 * metadata is scalar-only, so the server sends them as one string (`recording,notes`).
 */
export function meetingFileKinds(value: unknown): MeetingFileKind[] {
  const listed = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const present = new Set(listed);
  return ORDER.filter(kind => present.has(kind));
}

/** "recording", "notes" or "recording and notes". */
export function meetingFilesPhrase(kinds: readonly MeetingFileKind[], joiner = "and"): string {
  return ORDER.filter(kind => kinds.includes(kind)).join(` ${joiner} `);
}

/** What the organizer said they do not have. It never claims a file does not exist. */
export function notAvailableMessage(kinds: readonly MeetingFileKind[]): string {
  return `The organizer says they don't have the ${kinds.length === 2 ? "recording or the notes" : meetingFilesPhrase(kinds)}.`;
}

/**
 * A meeting-file row in the Feed. `side` is the viewer's side of the request.
 * Returns null for any row that is not a meeting-file request, so every other
 * Drive row keeps its own wording.
 */
export function meetingFeedLine(
  eventType: string,
  side: "requester" | "organizer",
  status: string,
  metadata: Record<string, unknown>,
): string | null {
  if (metadata.calendar_meeting !== true) return null;
  const requested = meetingFileKinds(metadata.calendar_requested_types);
  const missing = meetingFileKinds(metadata.not_available_types);
  switch (eventType) {
    case "document_share_request_sent":
      return "Request sent · Waiting for organizer";
    case "document_share_request":
      return requested.length ? `Asked for your meeting ${meetingFilesPhrase(requested)}` : "Asked for your meeting files";
    case "document_share_decided": {
      if (!missing.length) return null;
      const open = requested.filter(kind => !missing.includes(kind));
      if (side === "organizer") return `Saved: no ${meetingFilesPhrase(missing, "or")} to share`;
      return status === "pending" && open.length
        ? `${notAvailableMessage(missing)} Waiting for the ${meetingFilesPhrase(open, "and")}.`
        : notAvailableMessage(missing);
    }
    default:
      return null;
  }
}
