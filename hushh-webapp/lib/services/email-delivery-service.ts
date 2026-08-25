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
};

export type EmailDraftResult = EmailDraft & {
  missingDetails: string[];
};

export type PreparedEmailSend = {
  actionId: string;
  expiresAt: string | null;
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
    return this.code === "GMAIL_SEND_PERMISSION_REQUIRED";
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
    return "Reconnect Gmail to grant email sending permission.";
  }
  if (code === "GMAIL_NOT_CONNECTED") {
    return "Connect Gmail before you draft or send email.";
  }
  if (code === "EMAIL_ACTION_EXPIRED") {
    return "This email review expired. Review the unchanged draft again.";
  }
  if (code === "EMAIL_ACTION_ALREADY_USED") {
    return "This email action was already used. Check Sent Mail before trying again.";
  }
  if (code === "EMAIL_ACTION_OUTCOME_UNKNOWN") {
    return "We could not confirm delivery. Check Sent Mail before trying again.";
  }
  if (status === 401 || status === 403) {
    return "Unlock your vault and try again.";
  }
  return "Email could not be completed. Please review the draft and try again.";
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
    const payload = await postJson<unknown>("/api/one/email/prepare", input, {
      to: input.draft.to,
      cc: input.draft.cc,
      bcc: input.draft.bcc,
      subject: input.draft.subject,
      body: input.draft.body,
      idempotency_key: input.idempotencyKey,
    });
    const record = asRecord(payload);
    return {
      actionId: stringValue(record, "action_id", "actionId"),
      expiresAt: stringValue(record, "expires_at", "expiresAt") || null,
    };
  }

  static async send(input: EmailDeliveryAuth & {
    actionId: string;
    draft: EmailDraft;
  }): Promise<SentEmailResult> {
    const payload = await postJson<unknown>("/api/one/email/send", input, {
      action_id: input.actionId,
      to: input.draft.to,
      cc: input.draft.cc,
      bcc: input.draft.bcc,
      subject: input.draft.subject,
      body: input.draft.body,
    });
    const record = asRecord(payload);
    return {
      messageId: stringValue(record, "message_id", "messageId") || null,
      threadId: stringValue(record, "thread_id", "threadId") || null,
      outcomeUnknown: record?.outcome_unknown === true || record?.outcomeUnknown === true,
    };
  }
}
