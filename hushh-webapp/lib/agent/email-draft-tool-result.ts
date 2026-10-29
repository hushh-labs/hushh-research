/**
 * The server's answer to `open_gmail_email_draft`, read as authored metadata
 * only: its status, the envelope it resolved and its advisory Gmail send
 * readiness. Its message and recipient names are written for One, not for the
 * card, so they are not read here.
 */

export const GMAIL_SEND_READINESS = [
  "ready",
  "connect_required",
  "send_permission_required",
  "send_disabled",
  "unknown",
] as const;

export type GmailSendReadiness = (typeof GMAIL_SEND_READINESS)[number];

const EMAIL_DRAFT_TOOL_STATUSES = [
  "draft_opened",
  "recipient_choice_needed",
  "recipient_not_found",
  "recipient_email_unavailable",
  "invalid_recipient",
  "invalid_draft",
  "invalid_file_selection",
  "authentication_required",
  "missing_request",
] as const;

export type EmailDraftToolStatus = (typeof EMAIL_DRAFT_TOOL_STATUSES)[number];

/** Comma-separated recipients as editable draft fields; empty when none. */
export type EmailDraftEnvelope = { to: string; cc: string; bcc: string };

export type EmailDraftToolResult = {
  /** Null for a status this client does not know; that is never `draft_opened`. */
  status: EmailDraftToolStatus | null;
  /** Null when absent or malformed; then the model's arguments stay the draft. */
  envelope: EmailDraftEnvelope | null;
  gmailSend: GmailSendReadiness | null;
};

/** The bound the tool itself applies to each of to, cc and bcc. */
const RECIPIENT_FIELD_LIMIT = 2_048;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** Absent means empty; anything else must be a bounded single-line string. */
function recipientField(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length <= RECIPIENT_FIELD_LIMIT && !/[\x00-\x1f\x7f]/.test(trimmed)
    ? trimmed
    : null;
}

function parseEnvelope(value: unknown): EmailDraftEnvelope | null {
  const input = record(value);
  if (!input) return null;
  const to = recipientField(input.to);
  const cc = recipientField(input.cc);
  const bcc = recipientField(input.bcc);
  return to === null || cc === null || bcc === null ? null : { to, cc, bcc };
}

/**
 * Accepts the result as a JSON string or object, optionally wrapped in
 * `result`, `content` or `data`. Returns null when no status is present, as
 * from a server that predates this contract, so the caller keeps its old path.
 */
export function parseEmailDraftToolResult(value: unknown): EmailDraftToolResult | null {
  const outer = parseRecord(value);
  if (!outer) return null;
  const result = typeof outer.status === "string"
    ? outer
    : [outer.result, outer.content, outer.data]
      .map(parseRecord)
      .find((candidate) => typeof candidate?.status === "string");
  if (!result) return null;
  return {
    status: oneOf(EMAIL_DRAFT_TOOL_STATUSES, result.status),
    envelope: parseEnvelope(result.envelope),
    gmailSend: oneOf(GMAIL_SEND_READINESS, result.gmail_send),
  };
}
