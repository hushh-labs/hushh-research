import { ApiService } from "@/lib/services/api-service";

/**
 * What the owner may be told about how completely their email was checked.
 * Only `needs_attention` asks the owner to do anything; `catching_up` is
 * background work that retries on its own and is shown quietly.
 */
export type FollowupCoverage = {
  coverage: "complete" | "catching_up" | "needs_attention";
  attention: "reconnect_mail" | "retry_needed" | "provider_unavailable" | null;
  waiting_source_count: number;
  exhausted_source_count: number;
  unreadable_count: number;
};

export type FollowupStatus = {
  account_id: string;
  mail_connected: boolean;
  monitoring_enabled: boolean;
  /** True when the stored monitor matches the live Mail grant. */
  monitor_current?: boolean;
  background_available: boolean;
  scan_state: "off" | "pending" | "partial" | "complete";
  incomplete_source_count: number;
  coverage?: FollowupCoverage | null;
  last_complete_at?: string | null;
  notifications_enabled: boolean;
  reminder_lead_days?: number | null;
  reminder_hour?: number | null;
  historical_start_at: string | null;
  time_zone: string | null;
};

export type FollowupCategory =
  | "meeting_request" | "schedule_change" | "document_or_information"
  | "deliverable_deadline" | "response_needed" | "assigned_task";

export type FollowupPreviewRequest = {
  id: string; kind: "action" | "deadline" | "meeting"; state: string;
  title: string; original_due_wording: string | null;
  due_date: string | null; proposed_date: string | null; ambiguities: string[];
  due_relation?: string | null; proposed_at?: string | null;
  category?: FollowupCategory | null;
  /** `asap` is the sender's stated urgency; it never implies a due date. */
  urgency?: "asap" | "time_bound" | "none";
  /** `proposed` means the email suggests a meeting that is not on the Calendar. */
  meeting_state?: "proposed" | "confirmed" | "none";
  responsibility?: string;
};
export type FollowupConversation = {
  id: string; subject: string; sender: string; latest_internal_date_ms: number;
  request_count: number; active_count: number; source_completeness: "complete" | "partial";
  preview_requests: FollowupPreviewRequest[];
};
export type FollowupList = {
  account_id: string; scan_state: FollowupStatus["scan_state"];
  incomplete_source_count: number; total_conversations: number;
  coverage?: FollowupCoverage | null;
  next_offset: number | null;
  conversations: FollowupConversation[];
};
export type FollowupReminderStatus = "none" | "scheduled" | "sent" | "closed";
/** A real Calendar event this email is about: [event id, title, start]. */
export type FollowupLinkedEvent = [string, string, string];
export type FollowupRequest = FollowupPreviewRequest & {
  source_excerpt: string; due_relation: string | null; proposed_at: string | null;
  time_zone: string | null; responsibility: string; reminder_at: string | null;
  source_internal_date_ms: number; revision: number;
  booking_state: "not_booked" | "booked" | null;
  reminder_status?: FollowupReminderStatus;
  linked_event?: FollowupLinkedEvent | null;
};
export type FollowupDetail = Omit<FollowupConversation, "request_count" | "active_count" | "preview_requests"> & {
  account_id: string; requests: FollowupRequest[];
};
export type FollowupSource = {
  request_id: string; account_id: string; subject: string; sender: string;
  body: string; internal_date_ms: number; gmail_message_id?: string;
};
export type FollowupSourceLink = { request_id: string; account_id: string; gmail_message_id: string };

export class FollowupRequestError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}
function validateAccount(value: unknown, accountId: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || value.account_id !== accountId) throw new Error("Selected Mail account changed. Refresh Follow-ups.");
}

export class CalendarFollowupsService {
  static async post<T>(path: string, body: Record<string, unknown>, idToken: string, vaultOwnerToken?: string | null, signal?: AbortSignal): Promise<T> {
    const response = await ApiService.apiFetch(`/api/one/calendar/followups/${path}`, {
      method: "POST", cache: "no-store", signal,
      headers: {
        Authorization: `Bearer ${idToken}`, "Content-Type": "application/json",
        ...(vaultOwnerToken ? { "X-Hushh-Consent": `Bearer ${vaultOwnerToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = isRecord(value) && isRecord(value.detail) ? value.detail : null;
      throw new FollowupRequestError(typeof detail?.code === "string" ? detail.code : "FOLLOWUPS_UNAVAILABLE", response.status);
    }
    if (!isRecord(value)) throw new Error("Follow-ups response was incomplete.");
    return value as T;
  }

  static async status(userId: string, accountId: string, idToken: string, signal?: AbortSignal): Promise<FollowupStatus> {
    const value = await this.post<FollowupStatus>("status", { user_id: userId, account_id: accountId }, idToken, null, signal);
    validateAccount(value, accountId);
    if (typeof value.mail_connected !== "boolean" || typeof value.monitoring_enabled !== "boolean" ||
      !["off", "pending", "partial", "complete"].includes(String(value.scan_state))) throw new Error("Follow-ups status was incomplete.");
    return value;
  }

  static async list(userId: string, accountId: string, idToken: string, ownerToken: string, signal?: AbortSignal, offset = 0): Promise<FollowupList> {
    const value = await this.post<FollowupList>("list", { user_id: userId, account_id: accountId, offset }, idToken, ownerToken, signal);
    validateAccount(value, accountId);
    if (!Array.isArray(value.conversations) || !Number.isInteger(value.total_conversations) ||
      (value.next_offset !== null && (!Number.isInteger(value.next_offset) || value.next_offset <= offset)) ||
      value.conversations.some(item => !isRecord(item) || !validUuid(item.id) || !Array.isArray(item.preview_requests) ||
        item.preview_requests.some(request => !isRecord(request) || !validUuid(request.id) || typeof request.title !== "string")))
      throw new Error("Follow-ups list was incomplete.");
    return value;
  }

  static async detail(userId: string, accountId: string, conversationId: string, idToken: string, ownerToken: string, signal?: AbortSignal): Promise<FollowupDetail> {
    if (!validUuid(conversationId)) throw new Error("Choose a valid conversation.");
    const value = await this.post<FollowupDetail>("detail", { user_id: userId, account_id: accountId, conversation_id: conversationId }, idToken, ownerToken, signal);
    validateAccount(value, accountId);
    if (value.id !== conversationId || !Array.isArray(value.requests) || value.requests.some(item => !isRecord(item) || !validUuid(item.id) || !Number.isInteger(item.revision)))
      throw new Error("Follow-up details were incomplete.");
    return value;
  }

  static async source(userId: string, accountId: string, requestId: string, idToken: string, ownerToken: string, signal?: AbortSignal): Promise<FollowupSource> {
    if (!validUuid(requestId)) throw new Error("Choose a valid request.");
    const value = await this.post<FollowupSource>("source", { user_id: userId, account_id: accountId, request_id: requestId }, idToken, ownerToken, signal);
    validateAccount(value, accountId);
    if (value.request_id !== requestId || typeof value.body !== "string" || typeof value.subject !== "string") throw new Error("Source email was incomplete.");
    return value;
  }

  /** The Gmail reference for one request; the message itself is not read. */
  static async sourceLink(userId: string, accountId: string, requestId: string, idToken: string, ownerToken: string, signal?: AbortSignal): Promise<FollowupSourceLink> {
    if (!validUuid(requestId)) throw new Error("Choose a valid request.");
    const value = await this.post<FollowupSourceLink>("source/link", { user_id: userId, account_id: accountId, request_id: requestId }, idToken, ownerToken, signal);
    validateAccount(value, accountId);
    if (value.request_id !== requestId || typeof value.gmail_message_id !== "string" || !value.gmail_message_id) throw new Error("Original email link was unavailable.");
    return value;
  }

  /**
   * Ask the server to continue the scan. It is bounded and rate-limited there:
   * a call that is not due yet returns without reading mail, so opening Insights
   * repeatedly never causes repeated full scans. `retry` is the owner's explicit
   * "check again" and clears exhausted retries.
   */
  static async scan(userId: string, accountId: string, idToken: string, ownerToken: string, options: { retry?: boolean } = {}, signal?: AbortSignal): Promise<void> {
    await this.post("scan", { user_id: userId, account_id: accountId, ...(options.retry ? { retry: true } : {}) }, idToken, ownerToken, signal);
  }

  static async resolve(userId: string, accountId: string, requestId: string, idToken: string, ownerToken: string, signal?: AbortSignal): Promise<string> {
    if (!validUuid(requestId)) throw new Error("Choose a valid request.");
    const value = await this.post<{ account_id: string; conversation_id: string }>("resolve", {
      user_id: userId, account_id: accountId, request_id: requestId,
    }, idToken, ownerToken, signal);
    validateAccount(value, accountId);
    if (!validUuid(value.conversation_id)) throw new Error("Follow-up source was unavailable.");
    return value.conversation_id;
  }

  static async change(userId: string, accountId: string, request: FollowupRequest, action: "done" | "dismiss" | "snooze" | "set_reminder", reminderAt: string | null, idToken: string, ownerToken: string): Promise<{ id: string; revision: number; state: string; reminder_at: string | null }> {
    const value = await this.post<{ id: string; revision: number; state: string; reminder_at: string | null }>("request", {
      user_id: userId, account_id: accountId, request_id: request.id,
      expected_revision: request.revision, idempotency_key: crypto.randomUUID(),
      action, reminder_at: reminderAt,
    }, idToken, ownerToken);
    if (value.id !== request.id || !Number.isInteger(value.revision) || typeof value.state !== "string") throw new Error("Follow-up action was not confirmed.");
    return value;
  }

  static async confirmBooking(userId: string, accountId: string, request: Pick<FollowupRequest, "id" | "revision">, eventId: string, idToken: string, ownerToken: string): Promise<void> {
    const value = await this.post<{ id: string; booking_state: string }>("booking/confirm", {
      user_id: userId, account_id: accountId, request_id: request.id,
      expected_revision: request.revision, idempotency_key: crypto.randomUUID(),
      event_id: eventId,
    }, idToken, ownerToken);
    if (value.id !== request.id || value.booking_state !== "booked") throw new Error("Calendar event was not linked to its follow-up.");
  }
}
