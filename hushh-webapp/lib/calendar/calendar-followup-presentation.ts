import type {
  FollowupConversation,
  FollowupPreviewRequest,
  FollowupRequest,
  FollowupCoverage,
} from "@/lib/services/calendar-followups-service";

/**
 * Plain-language wording for Follow-ups. Everything here is derived from fields
 * the server already verified; nothing invents a date, owner or urgency.
 */

const ACTIVE = new Set(["needs_review", "pending", "snoozed"]);

export function shortDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

function timeLabel(request: Pick<FollowupPreviewRequest, "proposed_at" | "ambiguities">, zone: string): string | null {
  if (!request.proposed_at || request.ambiguities.includes("time")) return null;
  const instant = new Date(request.proposed_at);
  if (!Number.isFinite(instant.getTime())) return null;
  return instant.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: zone });
}

/**
 * The verified date (or the honest absence of one) for a request.
 * "before 26 Oct" keeps the sender's exclusive wording; a proposed meeting
 * without a confirmed time says so rather than guessing one.
 */
export function dueText(request: FollowupPreviewRequest, zone = "UTC"): string {
  if (request.kind === "meeting" || request.meeting_state === "proposed") {
    const day = shortDate(request.proposed_date || request.proposed_at);
    if (!day) return "Time to confirm";
    const time = timeLabel(request, zone);
    return time ? `${day}, ${time} · Proposed` : `${day} · Time to confirm`;
  }
  const day = shortDate(request.due_date);
  if (day && request.bucket === "overdue") return `Overdue · was due ${day}`;
  if (day && request.bucket === "history" && request.after_date === "lapses" && isActive(request)) return `Ended ${day}`;
  if (day && request.category === "scheduled_event") return `On ${day}`;
  if (day) return request.due_relation === "before" ? `Due before ${day}` : `Due ${day}`;
  if (request.urgency === "asap") return "Urgent · No date given";
  return "No date given";
}

export function isActive(request: Pick<FollowupPreviewRequest, "state">): boolean {
  return ACTIVE.has(request.state);
}

function categoryRank(category: FollowupPreviewRequest["category"]): number {
  if (category === "document_or_information" || category === "deliverable_deadline") return 0;
  if (category === "meeting_request" || category === "schedule_change") return 1;
  return 2;
}

/**
 * The one request a conversation row is about: verified date, explicit
 * urgency, then document/deadline or meeting value. The server orders
 * conversations the same way, so the row and the order agree.
 */
export function primaryRequest(entry: Pick<FollowupConversation, "preview_requests">): FollowupPreviewRequest | undefined {
  const first = entry.preview_requests[0];
  if (first?.bucket) return first;
  const active = entry.preview_requests.filter(isActive);
  const pool = active.length ? active : entry.preview_requests;
  return [...pool].sort((left, right) => {
    const leftDate = left.due_date || left.proposed_date;
    const rightDate = right.due_date || right.proposed_date;
    const leftRank = leftDate ? 0 : left.urgency === "asap" ? 1 : 2;
    const rightRank = rightDate ? 0 : right.urgency === "asap" ? 1 : 2;
    return leftRank - rightRank || categoryRank(left.category) - categoryRank(right.category)
      || (leftDate || "9999").localeCompare(rightDate || "9999");
  })[0];
}

export function rowSummary(entry: FollowupConversation, zone = "UTC"): { title: string; detail: string } {
  const request = primaryRequest(entry);
  if (!request) return { title: "Follow-up", detail: "" };
  const more = Math.max(0, entry.active_count - 1);
  return {
    title: request.title,
    detail: [dueText(request, zone), more ? `+${more} more` : null].filter(Boolean).join(" · "),
  };
}

export function reminderText(request: FollowupRequest, zone: string): string {
  if (request.state === "done") return "Completed";
  if (request.state === "dismissed") return "Dismissed";
  if (request.state === "cancelled") return "Cancelled by the sender";
  if (request.state === "source_unavailable") return "The original email is no longer available";
  const when = request.reminder_at
    ? new Date(request.reminder_at).toLocaleString(undefined, { timeZone: zone, dateStyle: "medium", timeStyle: "short" })
    : null;
  if (request.reminder_status === "sent" && when) return `Reminder sent ${when}`;
  if (when) return `Reminder ${when}`;
  return request.due_date || request.proposed_date ? "No reminder set" : "No reminder · no date in the email";
}

export function gmailMessageUrl(accountEmail: string, gmailMessageId: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(accountEmail)}/#all/${encodeURIComponent(gmailMessageId)}`;
}

export type CoverageNotice = { tone: "quiet" | "action"; text: string; action: "reconnect" | null };

/**
 * A recoverable background retry is quiet. Only a state the owner can fix gets
 * wording and an action; this is never shown as a warning while Google is
 * simply being retried.
 */
export function coverageNotice(coverage: FollowupCoverage | null | undefined, vaultUnlocked = true): CoverageNotice | null {
  if (!coverage || coverage.coverage === "complete") return null;
  if (coverage.coverage === "catching_up") return { tone: "quiet", text: "Catching up on your email…", action: null };
  if (coverage.attention !== "reconnect_mail") return null;
  if (!vaultUnlocked) return { tone: "quiet", text: "Unlock One to check your email.", action: null };
  return { tone: "action", text: "Email access needs to be renewed.", action: "reconnect" };
}

/** Said once when the email check has finished, so "Catching up" visibly ends. */
export const SYNCED_NOTICE = "Your email is synced.";

const SYNCED_SEEN_PREFIX = "one:followups-synced:";

/**
 * Whether this account's "synced" line was already shown. It is a per-browser
 * convenience, so an unavailable store (private window, blocked site data) just
 * means the line may appear again; it never blocks the card.
 */
export function syncedNoticeSeen(userId: string, accountId: string): boolean {
  try {
    return window.localStorage.getItem(`${SYNCED_SEEN_PREFIX}${userId}:${accountId}`) === "1";
  } catch {
    return false;
  }
}

/** Remember the line was shown (`true`), or arm it again for the next finish (`false`). */
export function rememberSyncedNotice(userId: string, accountId: string, seen: boolean): void {
  try {
    const key = `${SYNCED_SEEN_PREFIX}${userId}:${accountId}`;
    if (seen) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    /* a convenience only */
  }
}

/**
 * What the card says when a request fails. A locked vault is the owner's to fix
 * and says so; it is never reported as a failed check.
 */
export function followupErrorText(error: unknown): string {
  if (error instanceof Error && error.message === "FOLLOWUPS_SESSION_UNAVAILABLE") return "Your secure connection could not be restored. Try again.";
  if (error instanceof Error && error.message.startsWith("Unlock One")) return error.message;
  if (error instanceof Error && error.message === "FOLLOWUPS_DISABLED") return "Follow-ups are not available yet. Try again later.";
  if (error instanceof Error && error.message === "selected_mail_permission_required") return "Reconnect Mail for this account.";
  return "Follow-ups could not be checked. Try again.";
}
