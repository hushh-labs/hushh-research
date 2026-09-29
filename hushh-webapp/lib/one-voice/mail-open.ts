/**
 * Open the original message at a position One offered.
 *
 * One HTTP call, shaped like `mintVoiceTicket`: the vault owner token in an
 * `Authorization` header, a typed reason union out, never a raw status.
 *
 * The request carries a position and the offer it came from, never a Gmail id --
 * the client has never held one. The server resolves the position against the
 * offer it minted, fenced to the Google account those ids were resolved in, and
 * reads that one message. No model is involved, so a tap costs no turn and
 * cannot be answered with a different message than the one on screen.
 *
 * Both the tap and a spoken "open the second one" come through here, so the two
 * cannot drift apart.
 */

import { ApiService } from "@/lib/services/api-service";

export type MailOpenReason =
  | "auth_missing"
  | "invalid_request"
  /** The feature is withdrawn, or Mail reads are unavailable for this owner. */
  | "disabled"
  | "unauthorized"
  /** The row belongs to a list this conversation has since replaced. */
  | "offer_superseded"
  /** That position was never offered, or the offer has expired. */
  | "offer_unresolved"
  /** The message is no longer there, or the mailbox changed under the read. */
  | "source_changed"
  | "rate_limited"
  | "network"
  | "unknown";

export class MailOpenError extends Error {
  readonly reason: MailOpenReason;
  readonly status?: number;
  readonly code?: string | null;
  /** Present on `offer_superseded`: the revision that is live now. */
  readonly currentRevision?: number;

  constructor(
    reason: MailOpenReason,
    options: {
      status?: number;
      code?: string | null;
      currentRevision?: number;
      cause?: unknown;
    } = {},
  ) {
    super(`mail open unavailable: ${reason}`);
    this.name = "MailOpenError";
    this.reason = reason;
    this.status = options.status;
    this.code = options.code ?? null;
    this.currentRevision = options.currentRevision;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** One message, as the reader projected it. Absent fields stay absent. */
export type OpenedMailMessage = {
  sourceRef: string | null;
  subject: string | null;
  sender: string | null;
  receivedAt: string | null;
  body: string | null;
  /** The reader shortened the text to fit; the original is longer. */
  bodyTruncated: boolean;
};

function detailOf(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const detail = (body as { detail?: unknown }).detail;
  return detail && typeof detail === "object"
    ? (detail as Record<string, unknown>)
    : null;
}

function codeOf(body: unknown): string | null {
  const detail = detailOf(body);
  const code = detail?.code;
  if (typeof code === "string") return code;
  const plain = (body as { detail?: unknown } | null)?.detail;
  return typeof plain === "string" ? plain : null;
}

export function mailOpenReason(
  status: number,
  code: string | null,
): MailOpenReason {
  switch (code) {
    case "VOICE_MAIL_READS_DISABLED":
    case "MAIL_READS_UNAVAILABLE":
      return "disabled";
    case "MAIL_OFFER_SUPERSEDED":
      return "offer_superseded";
    case "MAIL_OFFER_UNRESOLVED":
      return "offer_unresolved";
    case "SOURCE_CHANGED":
    case "CONNECTION_CHANGED":
      return "source_changed";
    case "PERMISSION_DENIED":
      return "unauthorized";
    default:
      break;
  }
  if (status === 401) return "unauthorized";
  if (status === 403) return "disabled";
  if (status === 409) return "offer_unresolved";
  if (status === 410) return "source_changed";
  if (status === 422) return "invalid_request";
  if (status === 429) return "rate_limited";
  return "unknown";
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean || null;
}

/**
 * Read the one row the server returned. Nothing is defaulted into existence: a
 * missing subject stays null so the view can say it is missing rather than
 * showing something the message did not carry.
 */
export function parseOpenedMail(body: unknown): OpenedMailMessage | null {
  if (!body || typeof body !== "object") return null;
  const message = (body as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const row = message as Record<string, unknown>;
  const parsed: OpenedMailMessage = {
    sourceRef: text(row.source_ref),
    subject: text(row.subject),
    sender: text(row.sender),
    receivedAt: text(row.received_at),
    body: text(row.body),
    bodyTruncated: row.body_truncated === true,
  };
  // A row with nothing readable is not an opened message.
  if (!parsed.subject && !parsed.sender && !parsed.body) return null;
  return parsed;
}

export async function openOfferedMail(input: {
  vaultOwnerToken: string;
  conversationId: string;
  ordinal: number;
  offerRevision: number;
}): Promise<OpenedMailMessage> {
  const vaultOwnerToken = String(input.vaultOwnerToken || "").trim();
  const conversationId = String(input.conversationId || "").trim();
  if (!vaultOwnerToken) throw new MailOpenError("auth_missing");
  if (
    conversationId.length !== 36 ||
    !Number.isInteger(input.ordinal) ||
    input.ordinal < 1 ||
    !Number.isInteger(input.offerRevision) ||
    input.offerRevision < 1
  ) {
    // Refused here rather than sent. An unbound request would mean "whatever
    // list is current", which is the substitution this whole path prevents.
    throw new MailOpenError("invalid_request");
  }

  let response: Response;
  try {
    response = await ApiService.apiFetch("/api/one/voice/mail/open", {
      method: "POST",
      headers: ApiService.getAuthHeaders(vaultOwnerToken),
      body: JSON.stringify({
        conversation_id: conversationId,
        ordinal: input.ordinal,
        offer_revision: input.offerRevision,
      }),
    });
  } catch (error) {
    throw new MailOpenError("network", { cause: error });
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const code = codeOf(body);
    const detail = detailOf(body);
    const currentRevision = detail?.current_revision;
    throw new MailOpenError(mailOpenReason(response.status, code), {
      status: response.status,
      code,
      currentRevision:
        typeof currentRevision === "number" ? currentRevision : undefined,
    });
  }

  const parsed = parseOpenedMail(body);
  // A 200 whose body does not describe a message is a failure, not an empty
  // message. Rendering it as an opened message with no content would tell the
  // person their mail is blank.
  if (!parsed) throw new MailOpenError("unknown", { status: response.status });
  return parsed;
}
