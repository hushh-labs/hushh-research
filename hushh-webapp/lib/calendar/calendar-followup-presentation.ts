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

export function senderName(value: string): string {
  const name = (value.split("<")[0] ?? "").trim().replace(/^"|"$/g, "");
  if (name && !name.includes("@")) return name;
  const address = value.match(/<([^>]+)>/)?.[1] ?? value;
  return address.split("@")[0] || value;
}

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
  if (day) return request.due_relation === "before" ? `Due before ${day}` : `Due ${day}`;
  if (request.urgency === "asap") return "Urgent · No date given";
  return "No date given";
}

export function isActive(request: Pick<FollowupPreviewRequest, "state">): boolean {
  return ACTIVE.has(request.state);
}

/**
 * The one request a conversation row is about: the earliest verified date,
 * then explicit urgency, then the first active item. The server orders
 * conversations the same way, so the row and the order agree.
 */
export function primaryRequest(entry: Pick<FollowupConversation, "preview_requests">): FollowupPreviewRequest | undefined {
  const active = entry.preview_requests.filter(isActive);
  const pool = active.length ? active : entry.preview_requests;
  const dated = pool
    .map(item => ({ item, at: item.due_date || item.proposed_date }))
    .filter((entry): entry is { item: FollowupPreviewRequest; at: string } => Boolean(entry.at))
    .sort((a, b) => a.at.localeCompare(b.at));
  return dated[0]?.item ?? pool.find(item => item.urgency === "asap") ?? pool[0];
}

export function rowSummary(entry: FollowupConversation, zone = "UTC"): { title: string; detail: string; more: number } {
  const next = primaryRequest(entry);
  const active = entry.preview_requests.filter(isActive).length || entry.active_count;
  const detail = [next ? dueText(next, zone) : "Needs review", `From ${senderName(entry.sender)}`].join(" · ");
  return { title: next?.title || entry.subject, detail, more: Math.max(0, active - 1) };
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

export type CoverageNotice = { tone: "quiet" | "action"; text: string; action: "reconnect" | "retry" | null };

/**
 * A recoverable background retry is quiet. Only a state the owner can fix gets
 * wording and an action; this is never shown as a warning while Google is
 * simply being retried.
 */
export function coverageNotice(coverage: FollowupCoverage | null | undefined): CoverageNotice | null {
  if (!coverage || coverage.coverage === "complete") return null;
  if (coverage.coverage === "catching_up") return { tone: "quiet", text: "Catching up on your email…", action: null };
  if (coverage.attention === "reconnect_mail") return { tone: "action", text: "Email access needs to be renewed.", action: "reconnect" };
  if (coverage.attention === "provider_unavailable") return { tone: "action", text: "Google is not responding right now. We’ll keep trying.", action: "retry" };
  return { tone: "action", text: "A few emails could not be read yet.", action: "retry" };
}
