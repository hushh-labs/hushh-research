export type GmailNudgeType = "needs_reply" | "upcoming_meeting";

export interface GmailNudge {
  type: GmailNudgeType;
  thread_id: string;
  message_id: string;
  title: string;
  sender: string;
  sender_email: string;
  received_at: string | null;
  /** Meeting start time for upcoming_meeting nudges; null otherwise. */
  starts_at?: string | null;
  /** Conferencing "join" link for upcoming_meeting nudges; null when unavailable. */
  meeting_url?: string | null;
  ical_uid?: string | null;
  meeting_source?: "invite" | "email" | null;
}

export interface GmailNudgesResponse {
  user_id: string;
  account_email: string | null;
  nudges: GmailNudge[];
  meeting_scan?: { scope: "recent_invitations_and_mentions"; status: "checked" | "unavailable" };
  next_cursor?: string | null;
  has_more?: boolean;
  coverage?: { scope: "mailbox_excluding_spam_trash"; scanned_threads: number; failed_threads: number; complete: boolean; as_of: string };
}

export function validateGmailScanCoverage(payload: GmailNudgesResponse, ownerId: string): void {
    if ((payload.user_id !== ownerId || !Array.isArray(payload.nudges) || payload.nudges.length > 25 ||
        payload.coverage?.scope !== "mailbox_excluding_spam_trash" || !Number.isSafeInteger(payload.coverage.scanned_threads) || payload.coverage.scanned_threads < 0 ||
        !Number.isSafeInteger(payload.coverage.failed_threads) || payload.coverage.failed_threads < 0 || payload.coverage.failed_threads > 25 ||
        typeof payload.has_more !== "boolean" || typeof payload.coverage.complete !== "boolean" || payload.coverage.complete === payload.has_more ||
        payload.has_more !== Boolean(payload.next_cursor) || (payload.next_cursor && (typeof payload.next_cursor !== "string" || payload.next_cursor.length > 8192)) ||
        payload.coverage.complete && payload.coverage.failed_threads > 0)) throw new Error("Email follow-up coverage could not be verified.");
}
