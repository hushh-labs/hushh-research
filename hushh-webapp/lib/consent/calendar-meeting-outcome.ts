/**
 * What an organizer sees after approving a Calendar meeting file request.
 *
 * Server truth, not optimism: "approved" means Drive sharing is queued or
 * running, so it reads as Sharing. Only a status the server settled on reads as
 * an outcome, and "completed" says Drive finished, never that the requester can
 * open the files (their Calendar verifies that with their own account).
 */
export type MeetingOutcomeTone = "progress" | "success" | "warning" | "error" | "neutral";

export type MeetingOutcome = {
  /** True while the server may still change this; the card keeps polling. */
  inProgress: boolean;
  tone: MeetingOutcomeTone;
  title: string;
  detail: string;
};

/** Statuses that mean a person still has to review. They have no outcome yet. */
const REVIEWING = new Set(["pending", "preparing", "review_ready"]);

export function isMeetingReviewing(status: string): boolean {
  return REVIEWING.has(status);
}

export function meetingOutcome(status: string): MeetingOutcome | null {
  if (REVIEWING.has(status)) return null;
  switch (status) {
    case "approved":
      return {
        inProgress: true, tone: "progress", title: "Sharing…",
        detail: "Google Drive is giving access. You can leave this page; the requester's Calendar updates once their account can open the files.",
      };
    case "completed":
      return {
        inProgress: false, tone: "success", title: "Access given",
        detail: "Google Drive finished sharing. The requester's Calendar shows the files once their selected Google account can open them.",
      };
    case "partial":
      return {
        inProgress: false, tone: "warning", title: "Some files were shared",
        detail: "Drive shared part of this request. The rest could not be shared. Check those files' sharing in Drive, then ask the requester to send a new request.",
      };
    case "failed":
      return {
        inProgress: false, tone: "error", title: "Sharing did not complete",
        detail: "Google Drive could not share these files. Check your Drive connection and the files' sharing settings, then ask the requester to request again.",
      };
    case "no_match":
      return {
        inProgress: false, tone: "warning", title: "No files were shared",
        detail: "No shareable recording or notes matched this request.",
      };
    case "declined":
      return { inProgress: false, tone: "neutral", title: "Request declined", detail: "Nothing was shared." };
    case "expired":
      return { inProgress: false, tone: "neutral", title: "Request expired", detail: "This request is no longer open." };
    default:
      return {
        inProgress: false, tone: "neutral", title: "Request updated",
        detail: `This request is ${status.replaceAll("_", " ")}.`,
      };
  }
}
