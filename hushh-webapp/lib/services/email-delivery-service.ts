import { ownerContentIsPrivate } from './private-agent-specialist-chat';
import { confirmPrivateGoogleAction, PrivateGoogleUnsupportedError } from './private-google-connections';
import { AuthService } from './auth-service';
import { ApiService } from "@/lib/services/api-service";

/**
 * The One email delivery boundary deliberately has no local persistence. The
 * server owns normalization, confirmation hashes, and the short-lived send
 * action; this client only carries the currently visible draft between clicks.
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
  driveAttachment?: DriveAttachmentPreview | null;
  attachmentToken?: string | null;
};

export type SentEmailResult = {
  messageId: string | null;
  threadId: string | null;
  outcomeUnknown: boolean;
};

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
      this.code === "GMAIL_SEND_DISABLED"
    );
  }

  /** Gmail was never connected: the fix is a first connection, not a reconnect. */
  get needsGmailConnect(): boolean {
    return this.code === "GMAIL_NOT_CONNECTED";
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
    return "Reconnect Mail to finish enabling mail sending.";
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
    return "That mailbox change is no longer available. Check Gmail before preparing another change.";
  }
  if (code === "GMAIL_MAILBOX_CONNECTION_CHANGED" || code === "GMAIL_MAILBOX_SOURCE_CHANGED") {
    return "Your mail changed since this review. Ask One to prepare the change again.";
  }
  if (code === "GMAIL_MAILBOX_UNAVAILABLE" || code === "GMAIL_MAILBOX_OUTCOME_UNKNOWN") {
    return "Gmail may have applied some or all of this change. Check Gmail before preparing another change.";
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

// A reviewed-draft fingerprint is held only in memory, never mail contents.
const privateSends = new Map<string, { owner: string; draftHash: string; expiresAt: number }>();
function privateEmailBody(draft: EmailDraft): Record<string, unknown> {
  if (draft.driveFileId || draft.sourceWorkflowId) throw new PrivateGoogleUnsupportedError('Attachments and source-bound Gmail replies');
  return { to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, html_body: draft.htmlBody ?? '' };
}
async function reviewedDraftHash(draft: EmailDraft): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(privateEmailBody(draft))));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}
async function preparePrivateEmail(draft: EmailDraft, action: 'save_draft' | 'send_email'): Promise<{ proposalId: string; expiresAt: string; owner: string }> {
  const owner = AuthService.getCurrentUser()?.uid;
  if (!owner) throw new Error('Sign in to connect your private agent.');
  const body = privateEmailBody(draft);
  const response = await ApiService.ownerPodRequest('actions/gmail/proposals', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, draft: body }),
  });
  if (!response.ok) throw await readFailure(response);
  const value = asRecord(await response.json());
  const preview = asRecord(value?.preview);
  // Only plain address lists whose exact envelope was already displayed are
  // supported here. Rich normalization requires a new explicit preview UI.
  const addresses = (raw: string) => raw.trim() ? raw.split(',').map(item => item.trim().toLowerCase()) : [];
  const exact = preview && ['to', 'cc', 'bcc'].every(field => JSON.stringify(preview[field]) === JSON.stringify(addresses(String(body[field])))) &&
    preview.subject === draft.subject && preview.body === draft.body && (preview.html_body ?? '') === (draft.htmlBody ?? '');
  const proposalId = stringValue(value, 'proposal_id');
  const expiresAt = stringValue(value, 'expires_at');
  if (AuthService.getCurrentUser()?.uid !== owner) throw new Error('Your signed-in account changed. Review again.');
  if (value?.status !== 'confirmation_required' || value.action !== action || !/^gmod_[A-Za-z0-9_-]{16,64}$/.test(proposalId) || !exact || !(Date.parse(expiresAt) > Date.now()))
    throw new EmailDeliveryError('The prepared message differs from your review. Use plain email addresses and review again.', 409, 'PRIVATE_EMAIL_REVIEW_REQUIRED');
  return { proposalId, expiresAt, owner };
}

async function postJson<T>(
  path: string,
  auth: EmailDeliveryAuth,
  body: Record<string, unknown>,
): Promise<T> {
  if (await ownerContentIsPrivate()) throw new PrivateGoogleUnsupportedError('This shared email operation');
  const response = await ApiService.apiFetch(path, {
    method: "POST",
    headers: emailHeaders(auth),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await readFailure(response);
  return (await response.json()) as T;
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
  static async saveGmailDraft(input: EmailDeliveryAuth & {
    draft: EmailDraft;
  }): Promise<void> {
    if (await ownerContentIsPrivate()) {
      const prepared = await preparePrivateEmail(input.draft, 'save_draft');
      const result = await confirmPrivateGoogleAction(prepared.proposalId, 'gmail_mailbox');
      if (result.status !== 'saved' || result.action !== 'save_draft' || typeof result.draft_id !== 'string') throw new EmailDeliveryError('Check Gmail Drafts before trying again.', 502);
      return;
    }
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
    if (await ownerContentIsPrivate()) {
      const result = await confirmPrivateGoogleAction(input.proposalId, 'gmail_mailbox');
      if (result.status !== 'executed' || typeof result.action !== 'string' || !Number.isInteger(result.count) || Number(result.count) < 0) throw new EmailDeliveryError('Check Gmail before trying again.', 502);
      return { action: result.action, count: Number(result.count) };
    }
    let payload: Record<string, unknown> | null;
    try {
      payload = asRecord(
        await postJson<unknown>("/api/one/email/mailbox/execute", input, {
          proposal_id: input.proposalId,
        }),
      );
    } catch (error) {
      if (error instanceof EmailDeliveryError && error.code) throw error;
      throw new EmailDeliveryError(
        safeErrorMessage("GMAIL_MAILBOX_OUTCOME_UNKNOWN", 502),
        502,
        "GMAIL_MAILBOX_OUTCOME_UNKNOWN",
      );
    }
    const count = payload?.count;
    if (payload?.status !== "executed" || typeof count !== "number" || !Number.isInteger(count) || count < 0 || !stringValue(payload, "action")) {
      throw new EmailDeliveryError(
        safeErrorMessage("GMAIL_MAILBOX_OUTCOME_UNKNOWN", 502), 502, "GMAIL_MAILBOX_OUTCOME_UNKNOWN",
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
  }): Promise<PreparedEmailSend> {
    if (await ownerContentIsPrivate()) {
      const prepared = await preparePrivateEmail(input.draft, 'send_email');
      for (const [id, held] of privateSends) if (held.expiresAt <= Date.now() || held.owner !== prepared.owner) privateSends.delete(id);
      privateSends.set(prepared.proposalId, { owner: prepared.owner, draftHash: await reviewedDraftHash(input.draft), expiresAt: Date.parse(prepared.expiresAt) });
      return { actionId: prepared.proposalId, expiresAt: prepared.expiresAt, driveAttachment: null, attachmentToken: null };
    }
    const payload = await postJson<unknown>("/api/one/email/prepare", input, {
      to: input.draft.to,
      cc: input.draft.cc,
      bcc: input.draft.bcc,
      subject: input.draft.subject,
      body: input.draft.body,
      html_body: input.draft.htmlBody,
      idempotency_key: input.idempotencyKey,
      ...(input.draft.driveFileId
        ? { drive_attachment: { file_id: input.draft.driveFileId } }
        : {}),
      ...(input.draft.sourceWorkflowId
        ? { source_workflow_id: input.draft.sourceWorkflowId }
        : {}),
    });
    const record = asRecord(payload);
    const attachment = asRecord(record?.drive_attachment);
    return {
      actionId: stringValue(record, "action_id", "actionId"),
      expiresAt: stringValue(record, "expires_at", "expiresAt") || null,
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
  }): Promise<SentEmailResult> {
    if (await ownerContentIsPrivate()) {
      const held = privateSends.get(input.actionId);
      if (!held || held.owner !== AuthService.getCurrentUser()?.uid || held.expiresAt <= Date.now() || input.attachmentToken || held.draftHash !== await reviewedDraftHash(input.draft)) throw new EmailDeliveryError('This message needs a new review before sending.', 409, 'PRIVATE_EMAIL_REVIEW_REQUIRED');
      privateSends.delete(input.actionId);
      const result = await confirmPrivateGoogleAction(input.actionId, 'gmail_mailbox');
      if (result.status !== 'sent' || result.action !== 'send_email' || typeof result.message_id !== 'string') throw new EmailDeliveryError('Check Sent Mail before trying again.', 502, 'GMAIL_SEND_OUTCOME_UNKNOWN');
      return { messageId: result.message_id, threadId: null, outcomeUnknown: false };
    }
    const payload = await postJson<unknown>("/api/one/email/send", input, {
      action_id: input.actionId,
      to: input.draft.to,
      cc: input.draft.cc,
      bcc: input.draft.bcc,
      subject: input.draft.subject,
      body: input.draft.body,
      html_body: input.draft.htmlBody,
      ...(input.attachmentToken
        ? { attachment_token: input.attachmentToken }
        : {}),
      ...(input.draft.sourceWorkflowId
        ? { source_workflow_id: input.draft.sourceWorkflowId }
        : {}),
    });
    const record = asRecord(payload);
    return {
      messageId: stringValue(record, "message_id", "messageId") || null,
      threadId: stringValue(record, "thread_id", "threadId") || null,
      outcomeUnknown: record?.outcome_unknown === true || record?.outcomeUnknown === true,
    };
  }
}
