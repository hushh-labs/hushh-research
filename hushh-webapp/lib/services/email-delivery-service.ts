import { ApiService } from "@/lib/services/api-service";

/**
 * The server owns normalization, confirmation hashes, and the send action.
 * Session storage retains only opaque action IDs for response-loss recovery;
 * drafts, auth credentials, provider IDs and send tokens never enter it.
 */
export type EmailDraft = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  /** Gmail-safe rich representation derived from the owner-reviewed body. */
  htmlBody?: string;
  /** An untrusted selection hint; the server resolves and binds the exact file. */
  driveFileId?: string;
  /** Opaque Gmail information-request reference; the server derives the reply envelope. */
  sourceWorkflowId?: string;
  /**
   * Opaque reference to an email One showed, for a reply in its own thread.
   * The server derives recipient, subject and thread from it on every prepare
   * and send; only the body here is the person's.
   */
  sourceMailRef?: string;
};

export type DriveAttachmentPreview = {
  filename: string;
  mimeType: string;
  size: number;
  sourceAccountLabel: string;
};

export type EmailDraftResult = EmailDraft & {
  missingDetails: string[];
};

export type PreparedEmailSend = {
  actionId: string;
  expiresAt: string | null;
  senderToken?: string | null;
  senderLabel?: string | null;
  driveAttachment?: DriveAttachmentPreview | null;
  attachmentToken?: string | null;
};

export type SentEmailResult = {
  /** The send action the server recorded, which the voice relay can re-read. */
  actionId: string | null;
  messageId: string | null;
  threadId: string | null;
  outcomeUnknown: boolean;
};

export type EmailSendStatus = {
  actionId: string;
  state: "prepared" | "sending" | "sent" | "failed" | "outcome_unknown" | "expired" | "cancelled";
};

const PENDING_SEND_STORAGE_PREFIX = "one-email-pending-send-actions:v1:";
const PENDING_SEND_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_SEND_ACTIONS = 8;
const ACTION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

type PendingSendSurface = "chat" | "voice";
type PendingSendAction = { actionId: string; createdAt: number; surface: PendingSendSurface };

function pendingSendStorageKey(ownerId: string): string {
  return `${PENDING_SEND_STORAGE_PREFIX}${ownerId}`;
}

function readPendingSendActions(ownerId: string): PendingSendAction[] {
  if (!ownerId || typeof sessionStorage === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(pendingSendStorageKey(ownerId)) || "[]";
    if (raw.length > 4096) return [];
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) return [];
    const now = Date.now();
    return stored.filter((value): value is PendingSendAction => {
      const row = asRecord(value);
      return Boolean(
        row && typeof row.actionId === "string" && ACTION_ID_PATTERN.test(row.actionId) &&
        typeof row.createdAt === "number" && Number.isFinite(row.createdAt) &&
        row.createdAt <= now && now - row.createdAt <= PENDING_SEND_TTL_MS &&
        (row.surface === "chat" || row.surface === "voice")
      );
    }).slice(-MAX_PENDING_SEND_ACTIONS);
  } catch {
    return [];
  }
}

function writePendingSendActions(ownerId: string, actions: PendingSendAction[]): void {
  if (!ownerId || typeof sessionStorage === "undefined") return;
  try {
    if (actions.length) {
      sessionStorage.setItem(pendingSendStorageKey(ownerId), JSON.stringify(actions));
    } else {
      sessionStorage.removeItem(pendingSendStorageKey(ownerId));
    }
  } catch {
    // Storage availability never changes the send result or authorizes a retry.
  }
}

export function pendingEmailSendActionIds(ownerId: string, surface: PendingSendSurface = "chat"): string[] {
  const actions = readPendingSendActions(ownerId);
  writePendingSendActions(ownerId, actions);
  return actions.filter((action) => action.surface === surface).map((action) => action.actionId);
}

export function rememberPendingEmailSendAction(
  ownerId: string, actionId: string, surface: PendingSendSurface = "chat",
): void {
  if (!ownerId || !ACTION_ID_PATTERN.test(actionId)) return;
  const actions = readPendingSendActions(ownerId).filter((action) => action.actionId !== actionId);
  actions.push({ actionId, createdAt: Date.now(), surface });
  writePendingSendActions(ownerId, actions.slice(-MAX_PENDING_SEND_ACTIONS));
}

export function forgetPendingEmailSendAction(ownerId: string, actionId: string): void {
  if (!ownerId || !ACTION_ID_PATTERN.test(actionId)) return;
  writePendingSendActions(ownerId, readPendingSendActions(ownerId).filter(
    (action) => action.actionId !== actionId,
  ));
}

/** These codes come from Gmail's connector, not the owner's vault credentials. */
function gmailAuthorizationFailed(code: string | null, status: number): boolean {
  return (
    (code === "GMAIL_NOT_READY" || code === "GMAIL_SEND_NOT_READY") &&
    (status === 401 || status === 403)
  );
}

export class EmailDeliveryError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "EmailDeliveryError";
    this.status = status;
    this.code = code;
  }

  get needsGmailReconnect(): boolean {
    return (
      this.code === "GMAIL_SEND_PERMISSION_REQUIRED" ||
      // A reply re-reads its original email, which needs the read grant.
      this.code === "GMAIL_READ_PERMISSION_REQUIRED" ||
      gmailAuthorizationFailed(this.code, this.status)
    );
  }

  /** Gmail was never connected: the fix is a first connection, not a reconnect. */
  get needsGmailConnect(): boolean {
    return this.code === "GMAIL_NOT_CONNECTED";
  }

  get needsGmailSendingEnabled(): boolean {
    return this.code === "GMAIL_SEND_DISABLED";
  }
}

type EmailDeliveryAuth = {
  firebaseIdToken: string;
  vaultOwnerToken: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringValue(record: Record<string, unknown> | null, ...keys: string[]): string {
  if (!record) return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function stringList(record: Record<string, unknown> | null, ...keys: string[]): string[] {
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    }
  }
  return [];
}

function recipientString(record: Record<string, unknown> | null, ...keys: string[]): string {
  const direct = stringValue(record, ...keys);
  if (direct) return direct;
  return stringList(record, ...keys).join(", ");
}

function emailHeaders(auth: EmailDeliveryAuth): HeadersInit {
  return {
    Authorization: `Bearer ${auth.firebaseIdToken}`,
    "X-Hushh-Consent": `Bearer ${auth.vaultOwnerToken}`,
    "Content-Type": "application/json",
  };
}

function safeErrorMessage(code: string | null, status: number): string {
  if (code === "GMAIL_SEND_PERMISSION_REQUIRED") {
    return "Reconnect Mail to grant mail sending permission.";
  }
  if (code === "GMAIL_SEND_DISABLED") {
    return "Turn on Gmail sending to continue. Your draft is still here.";
  }
  if (code === "GMAIL_COMPOSE_PERMISSION_REQUIRED") {
    return "Enable Gmail drafts in Connectors, then review this draft again.";
  }
  if (code === "GMAIL_NOT_CONNECTED") {
    return "Connect Mail before you draft or send mail.";
  }
  if (code === "DRAFT_INVALID") {
    return "One could not make a usable draft. Try drafting again or edit it yourself.";
  }
  if (code === "DRAFT_UNAVAILABLE" || code === "GMAIL_DELIVERY_UNAVAILABLE" || status === 504) {
    return "One could not finish the draft right now. Please try again.";
  }
  if (code === "EMAIL_ACTION_EXPIRED") {
    return "This mail review expired. Review the unchanged draft again.";
  }
  if (code === "EMAIL_ACTION_ALREADY_USED") {
    return "This mail action was already used. Check Sent Mail before trying again.";
  }
  if (code === "EMAIL_ACTION_OUTCOME_UNKNOWN") {
    return "We could not confirm delivery. Check Sent Mail before trying again.";
  }
  if (code === "DRIVE_ATTACHMENT_UNAVAILABLE" || code === "DRIVE_ATTACHMENT_CHANGED" ||
      code === "IDEMPOTENCY_PAYLOAD_MISMATCH") {
    return "The selected Drive file or connection changed. Review the attachment again.";
  }
  if (code === "GMAIL_MODIFY_PERMISSION_REQUIRED") {
    return "Allow Gmail changes, then ask One to prepare this change again.";
  }
  if (code === "GMAIL_MAILBOX_PROPOSAL_UNAVAILABLE") {
    return "That mailbox change expired or was already used. Ask One to prepare it again.";
  }
  if (code === "GMAIL_MAILBOX_CONNECTION_CHANGED" || code === "GMAIL_MAILBOX_SOURCE_CHANGED") {
    return "Your mail changed since this review. Ask One to prepare the change again.";
  }
  if (code === "GMAIL_MAILBOX_UNAVAILABLE") {
    return "Gmail's response was interrupted. Check the mailbox before making this change again.";
  }
  if (code === "REPLY_SOURCE_CHANGED" || code === "REPLY_ACCOUNT_CHANGED") {
    return "The original email or your Mail connection changed. Ask One to prepare the reply again.";
  }
  if (code === "REPLY_SOURCE_REF_EXPIRED" || code === "REPLY_SOURCE_REF_INVALID") {
    return "This reply expired. Ask One to prepare it again.";
  }
  if (code === "REPLY_SOURCE_UNAVAILABLE") {
    return "The original email can't be found now, so this reply wasn't sent.";
  }
  if (
    code === "REPLY_TARGET_IS_OWNER" ||
    code === "REPLY_TARGET_AMBIGUOUS" ||
    code === "REPLY_RECIPIENT_INVALID" ||
    code === "REPLY_HEADERS_INVALID"
  ) {
    return "This email can't be replied to from here. Write a new email instead.";
  }
  if (code === "REPLY_SOURCE_RETRYABLE") {
    return "Mail couldn't check the original email just now. Nothing was sent. Try again.";
  }
  if (code === "MAIL_REPLY_UNAVAILABLE") {
    return "Replying from One is switched off right now. Nothing was sent.";
  }
  if (code === "GMAIL_READ_PERMISSION_REQUIRED") {
    return "Reconnect Mail to continue. Nothing was sent.";
  }
  if (code === "SOURCE_BOUND_ATTACHMENT_UNSUPPORTED") {
    return "A reply can't include an attachment. Nothing was sent.";
  }
  if (gmailAuthorizationFailed(code, status)) {
    return "Reconnect Mail to continue.";
  }
  if (status === 401 || status === 403) {
    return "Unlock your vault and try again.";
  }
  return "Mail could not be completed. Please review the draft and try again.";
}

async function readFailure(response: Response): Promise<EmailDeliveryError> {
  const payload = (await response.json().catch(() => null)) as unknown;
  const record = asRecord(payload);
  const detail = asRecord(record?.detail) || record;
  const code = stringValue(detail, "code") || null;
  // Provider responses can include mail content. Never reflect them into chat,
  // toasts, or error logs; show only a locally selected safe message.
  return new EmailDeliveryError(safeErrorMessage(code, response.status), response.status, code);
}

async function postJson<T>(
  path: string,
  auth: EmailDeliveryAuth,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await ApiService.apiFetch(path, {
    method: "POST",
    headers: emailHeaders(auth),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await readFailure(response);
  return (await response.json()) as T;
}

/** A reply is bound to exactly one original email; two bindings is a caller bug. */
function sourceBinding(draft: EmailDraft): Record<string, string> {
  if (draft.sourceWorkflowId && draft.sourceMailRef) {
    throw new EmailDeliveryError("A reply can have only one original email.", 400);
  }
  if (draft.sourceWorkflowId) return { source_workflow_id: draft.sourceWorkflowId };
  if (draft.sourceMailRef) return { source_mail_ref: draft.sourceMailRef };
  return {};
}

function draftFromPayload(payload: unknown): EmailDraftResult {
  const record = asRecord(payload);
  return {
    to: recipientString(record, "to"),
    cc: recipientString(record, "cc"),
    bcc: recipientString(record, "bcc"),
    subject: stringValue(record, "subject"),
    body: stringValue(record, "body"),
    missingDetails: stringList(record, "missing_details", "missingDetails"),
  };
}

export class EmailDeliveryService {
  /** Reconcile the same reviewed attempt after a lost response; this never sends. */
  static async sendStatus(input: EmailDeliveryAuth & { actionId: string }): Promise<EmailSendStatus> {
    if (!ACTION_ID_PATTERN.test(input.actionId)) {
      throw new EmailDeliveryError("That mail review is unavailable.", 404, "ACTION_NOT_FOUND");
    }
    const response = await ApiService.apiFetch(
      `/api/one/email/send/status/${encodeURIComponent(input.actionId)}`,
      { method: "POST", headers: emailHeaders(input) },
    );
    if (!response.ok) throw await readFailure(response);
    const record = asRecord(await response.json().catch(() => null));
    const state = stringValue(record, "state");
    if (stringValue(record, "action_id") !== input.actionId || ![
      "prepared", "sending", "sent", "failed", "outcome_unknown", "expired", "cancelled",
    ].includes(state)) {
      throw new EmailDeliveryError(
        "We could not confirm delivery. Check Sent Mail before trying again.",
        502,
        "EMAIL_ACTION_OUTCOME_UNKNOWN",
      );
    }
    return { actionId: input.actionId, state: state as EmailSendStatus["state"] };
  }

  static async saveGmailDraft(input: EmailDeliveryAuth & {
    draft: EmailDraft;
  }): Promise<void> {
    if (input.draft.driveFileId) {
      throw new EmailDeliveryError("Gmail draft attachments are not available yet.", 400);
    }
    const payload = await postJson<unknown>("/api/one/email/draft/save", input, {
      to: input.draft.to,
      cc: input.draft.cc,
      bcc: input.draft.bcc,
      subject: input.draft.subject,
      body: input.draft.body,
      html_body: input.draft.htmlBody,
    });
    const record = asRecord(payload);
    if (record?.status !== "saved" || !stringValue(record, "draft_id")) {
      throw new EmailDeliveryError(
        "Gmail may have saved this draft. Check Gmail Drafts before trying again.", 502,
      );
    }
  }
  /** Apply the exact reviewed mailbox change; the server holds its messages and labels. */
  static async executeMailboxProposal(
    input: EmailDeliveryAuth & { proposalId: string },
  ): Promise<{ action: string; count: number }> {
    const payload = asRecord(
      await postJson<unknown>("/api/one/email/mailbox/execute", input, {
        proposal_id: input.proposalId,
      }),
    );
    const count = payload?.count;
    const total = payload?.total;
    if (payload?.status === "partially_executed" || payload?.status === "outcome_unknown") {
      const confirmed = typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
      const reviewed = typeof total === "number" && Number.isInteger(total) && total >= confirmed
        ? total : null;
      const progress = reviewed !== null && confirmed > 0
        ? `Gmail confirmed ${confirmed} of ${reviewed} changes. `
        : "";
      throw new EmailDeliveryError(
        `${progress}The remaining result is uncertain. Check Gmail before making this change again.`,
        409,
        "GMAIL_MAILBOX_OUTCOME_UNKNOWN",
      );
    }
    if (payload?.status !== "executed" || typeof count !== "number") {
      throw new EmailDeliveryError(
        "Gmail may have applied this change. Check Gmail before making it again.", 502,
      );
    }
    return { action: stringValue(payload, "action"), count };
  }
  static async draft(input: EmailDeliveryAuth & { instruction: string }): Promise<EmailDraftResult> {
    const payload = await postJson<unknown>("/api/one/email/draft", input, {
      instruction: input.instruction,
    });
    return draftFromPayload(payload);
  }

  static async prepare(input: EmailDeliveryAuth & {
    draft: EmailDraft;
    idempotencyKey: string;
    draftRef?: string;
    revision?: number;
  }): Promise<PreparedEmailSend> {
    const payload = await postJson<unknown>("/api/one/email/prepare", input, {
      to: input.draft.to,
      cc: input.draft.cc,
      bcc: input.draft.bcc,
      subject: input.draft.subject,
      body: input.draft.body,
      html_body: input.draft.htmlBody,
      idempotency_key: input.idempotencyKey,
      ...(input.draftRef ? { draft_ref: input.draftRef, revision: input.revision } : {}),
      ...(input.draft.driveFileId
        ? { drive_attachment: { file_id: input.draft.driveFileId } }
        : {}),
      ...sourceBinding(input.draft),
    });
    const record = asRecord(payload);
    const attachment = asRecord(record?.drive_attachment);
    return {
      actionId: stringValue(record, "action_id", "actionId"),
      expiresAt: stringValue(record, "expires_at", "expiresAt") || null,
      senderToken: stringValue(record, "sender_token") || null,
      senderLabel: stringValue(record, "sender_label") || null,
      driveAttachment: attachment
        ? {
            filename: stringValue(attachment, "filename"),
            mimeType: stringValue(attachment, "mime_type"),
            size: typeof attachment.size === "number" ? attachment.size : 0,
            sourceAccountLabel: stringValue(attachment, "source_account_label"),
          }
        : null,
      attachmentToken: stringValue(record, "attachment_token") || null,
    };
  }

  static async send(input: EmailDeliveryAuth & {
    actionId: string;
    draft: EmailDraft;
    attachmentToken?: string | null;
    senderToken?: string | null;
    draftRef?: string;
    revision?: number;
  }): Promise<SentEmailResult> {
    const payload = await postJson<unknown>("/api/one/email/send", input, {
      action_id: input.actionId,
      ...(input.senderToken ? { sender_token: input.senderToken } : {}),
      ...(input.draftRef ? { draft_ref: input.draftRef, revision: input.revision } : {}),
      to: input.draft.to,
      cc: input.draft.cc,
      bcc: input.draft.bcc,
      subject: input.draft.subject,
      body: input.draft.body,
      html_body: input.draft.htmlBody,
      ...(input.attachmentToken
        ? { attachment_token: input.attachmentToken }
        : {}),
      ...sourceBinding(input.draft),
    });
    const record = asRecord(payload);
    const actionId = stringValue(record, "action_id", "actionId");
    const state = stringValue(record, "state");
    const outcomeUnknown = record?.outcome_unknown === true || record?.outcomeUnknown === true;
    if (actionId !== input.actionId || (state !== "sent" && state !== "outcome_unknown") ||
        (state === "sent" && outcomeUnknown)) {
      throw new EmailDeliveryError(
        "We could not confirm delivery. Check Sent Mail before trying again.",
        502,
        "EMAIL_ACTION_OUTCOME_UNKNOWN",
      );
    }
    return {
      actionId,
      messageId: stringValue(record, "message_id", "messageId") || null,
      threadId: stringValue(record, "thread_id", "threadId") || null,
      outcomeUnknown: state === "outcome_unknown",
    };
  }
}
