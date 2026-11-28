/**
 * The Mail Overview's four reads, shaped like `mail-open.ts`: the vault owner
 * token in an `Authorization` header, a typed reason union out, never a raw status.
 *
 * A row is named by `sourceId`, an opaque, account-bound identity the server
 * issues for one message. The browser has never held a Gmail id, and it is not a
 * list position either, so a refresh, a reorder or a search cannot make a row
 * point at a different email. The server resolves the id on every use.
 *
 * Nothing is defaulted into existence: a missing subject, sender or preview is
 * `null` so the screen can say it is missing instead of showing invented text.
 */

import { ApiService } from "@/lib/services/api-service";

const BASE = "/api/one/mail/overview";
const REQUEST_TIMEOUT_MS = 30_000;

/** The provider returns one bounded page; there is no continuation or total. */
export const MAIL_OVERVIEW_ROW_CAP = 25;
/** What Recent mail shows before "View more". */
export const MAIL_OVERVIEW_INITIAL_ROWS = 5;
export const MAIL_SEARCH_QUERY_MAX = 512;

export type MailOverviewReason =
  | "auth_missing"
  | "connect_required"
  | "reconnect_required"
  /** The connected Google account is not the one this list or row came from. */
  | "account_changed"
  /** The message is gone or can no longer be opened from this mailbox. */
  | "source_unavailable"
  | "source_invalid"
  /** Mail reads are switched off for this account. */
  | "unavailable"
  /** This agent runs privately and the shared hub cannot serve Mail. */
  | "private_runtime"
  | "too_large"
  | "reply_unavailable"
  /** This email cannot be replied to (it is yours, in Trash, has no address). */
  | "reply_not_possible"
  | "retryable"
  /** One could not finish the brief (model or time); Recent mail still works. */
  | "brief_unavailable"
  /** A brief for this owner is already being prepared. */
  | "brief_busy"
  | "network"
  | "aborted"
  | "unknown";

export class MailOverviewError extends Error {
  readonly reason: MailOverviewReason;
  readonly status?: number;
  readonly code: string | null;
  /** Authored by the server, never mail content; shown only for reasons it explains. */
  readonly serverMessage: string | null;

  constructor(
    reason: MailOverviewReason,
    options: {
      status?: number;
      code?: string | null;
      serverMessage?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(`mail overview unavailable: ${reason}`);
    this.name = "MailOverviewError";
    this.reason = reason;
    this.status = options.status;
    this.code = options.code ?? null;
    this.serverMessage = options.serverMessage ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export type MailOverviewScope = {
  kind: "recent" | "search";
  mailbox: "inbox" | "all_mail";
  /** The server's own words for what was covered, e.g. "Inbox". */
  label: string;
};

export type MailOverviewRow = {
  sourceId: string;
  subject: string | null;
  sender: string | null;
  preview: string | null;
  receivedAt: string | null;
  unread: boolean;
};

export type MailOverviewCoverage = {
  requested: number;
  returned: number;
  /** The provider reported more matches than this one page. Never a total. */
  moreAvailable: boolean;
  cap: number;
};

export type MailOverviewPage = {
  /** The Google account the server served this from. */
  account: string;
  scope: MailOverviewScope;
  items: MailOverviewRow[];
  coverage: MailOverviewCoverage;
};

export type OpenedOverviewMessage = {
  summary?: string;
  sourceId: string;
  subject: string | null;
  sender: string | null;
  receivedAt: string | null;
  unread: boolean;
  /** Readable text only. Never markup. */
  body: string;
  bodyTruncated: boolean;
};

export type MailReplySource = {
  /** An opaque, short-lived reference the existing reviewed reply flow accepts. */
  sourceMailRef: string;
  to: string;
  recipientLabel: string | null;
  subject: string;
  expiresInSeconds: number;
};

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean || null;
}

function detailOf(body: unknown): Record<string, unknown> | null {
  return record(record(body)?.detail);
}

export function mailOverviewReason(
  status: number,
  code: string | null,
): MailOverviewReason {
  switch (code) {
    case "CONNECT_REQUIRED":
      return "connect_required";
    case "RECONNECT_REQUIRED":
    case "PERMISSION_DENIED":
      return "reconnect_required";
    case "ACCOUNT_CHANGED":
      return "account_changed";
    case "SOURCE_CHANGED":
      return "source_unavailable";
    case "SOURCE_REF_INVALID":
      return "source_invalid";
    case "MAIL_READS_UNAVAILABLE":
      return "unavailable";
    case "AGENT_PRIVATE_RUNTIME_REQUIRED":
    case "AGENT_HOSTING_UNAVAILABLE":
      return "private_runtime";
    case "RESPONSE_TOO_LARGE":
      return "too_large";
    case "MAIL_REPLY_UNAVAILABLE":
      return "reply_unavailable";
    case "REPLY_TARGET_IS_OWNER":
    case "REPLY_SOURCE_UNAVAILABLE":
    case "REPLY_RECIPIENT_INVALID":
    case "REPLY_TARGET_AMBIGUOUS":
    case "REPLY_HEADERS_INVALID":
      return "reply_not_possible";
    case "BRIEF_UNAVAILABLE":
    case "BRIEF_TIMEOUT":
    case "BRIEF_INVALID":
      return "brief_unavailable";
    case "BRIEF_BUSY":
      return "brief_busy";
    case "CONNECTION_CHANGED":
    case "RETRYABLE":
    case "REPLY_SOURCE_RETRYABLE":
    case "MAIL_UNAVAILABLE":
      return "retryable";
    default:
      break;
  }
  if (status === 401) return "auth_missing";
  if (status === 429 || status >= 500) return "retryable";
  return "unknown";
}

export async function overviewPost(
  path: string,
  body: Record<string, unknown>,
  input: { vaultOwnerToken: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<unknown> {
  const vaultOwnerToken = String(input.vaultOwnerToken || "").trim();
  if (!vaultOwnerToken) throw new MailOverviewError("auth_missing");
  let response: Response;
  try {
    response = await ApiService.apiFetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        ...ApiService.getAuthHeaders(vaultOwnerToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: input.signal,
      timeoutMs: input.timeoutMs ?? REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    // A cancelled request is the caller changing its mind, not a failure.
    if (input.signal?.aborted || (error as Error)?.name === "AbortError") {
      throw new MailOverviewError("aborted", { cause: error });
    }
    throw new MailOverviewError("network", { cause: error });
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const detail = detailOf(parsed);
    const code = typeof detail?.code === "string" ? detail.code : null;
    const message = nullableText(detail?.message) ?? null;
    throw new MailOverviewError(mailOverviewReason(response.status, code), {
      status: response.status,
      code,
      serverMessage: message,
    });
  }
  return parsed;
}

export function malformed(): MailOverviewError {
  // A 200 that does not describe mail is a failure, never an empty inbox.
  return new MailOverviewError("unknown", { code: "MALFORMED_RESPONSE" });
}

function parseRow(value: unknown): MailOverviewRow {
  const row = record(value);
  const sourceId = typeof row?.source_id === "string" ? row.source_id : "";
  const subject = nullableText(row?.subject);
  const sender = nullableText(row?.sender);
  const preview = nullableText(row?.preview);
  const receivedAt = nullableText(row?.received_at);
  if (
    !row ||
    !/^ms1\.[A-Za-z0-9_-]{16,2044}$/.test(sourceId) ||
    subject === undefined ||
    sender === undefined ||
    preview === undefined ||
    receivedAt === undefined ||
    typeof row.unread !== "boolean"
  ) {
    throw malformed();
  }
  return { sourceId, subject, sender, preview, receivedAt, unread: row.unread };
}

export function parseMailOverviewPage(
  body: unknown,
  expectedKind: MailOverviewScope["kind"],
): MailOverviewPage {
  const root = record(body);
  const scope = record(root?.scope);
  const coverage = record(root?.coverage);
  const account = typeof root?.account === "string" ? root.account : "";
  if (
    !root ||
    !account ||
    !scope ||
    scope.kind !== expectedKind ||
    (scope.mailbox !== "inbox" && scope.mailbox !== "all_mail") ||
    typeof scope.label !== "string" ||
    !coverage ||
    typeof coverage.requested !== "number" ||
    typeof coverage.returned !== "number" ||
    typeof coverage.more_available !== "boolean" ||
    typeof coverage.cap !== "number" ||
    !Array.isArray(root.items)
  ) {
    throw malformed();
  }
  const items = root.items.map(parseRow);
  // Never duplicate a row: one message is one row, whichever order it arrives in.
  const seen = new Set<string>();
  const unique = items.filter((row) =>
    seen.has(row.sourceId) ? false : (seen.add(row.sourceId), true),
  );
  return {
    account,
    scope: {
      kind: scope.kind as MailOverviewScope["kind"],
      mailbox: scope.mailbox,
      label: scope.label,
    },
    items: unique,
    coverage: {
      requested: coverage.requested,
      returned: unique.length,
      moreAvailable: coverage.more_available,
      cap: coverage.cap,
    },
  };
}

export type Auth = {
  vaultOwnerToken: string;
  /** The Google account the screen is showing, as the connection status reports it. */
  expectedAccount?: string | null;
  signal?: AbortSignal;
};

export function accountField(input: Auth): { expected_account?: string } {
  const account = String(input.expectedAccount ?? "").trim();
  return account ? { expected_account: account } : {};
}

/** The newest Inbox mail, newest first. Reads nothing but the Inbox. */
export async function fetchRecentMail(
  input: Auth & { limit?: number },
): Promise<MailOverviewPage> {
  const limit = Math.min(
    MAIL_OVERVIEW_ROW_CAP,
    Math.max(1, Math.trunc(input.limit ?? MAIL_OVERVIEW_INITIAL_ROWS)),
  );
  return parseMailOverviewPage(
    await overviewPost("/recent", { limit, ...accountField(input) }, input),
    "recent",
  );
}

/** One explicit Gmail search over all mail except Spam and Trash. Never "all mail". */
export async function searchMail(
  input: Auth & { query: string },
): Promise<MailOverviewPage> {
  const query = input.query.trim();
  if (!query || new TextEncoder().encode(query).length > MAIL_SEARCH_QUERY_MAX) {
    throw new MailOverviewError("unknown", { code: "INVALID_QUERY" });
  }
  return parseMailOverviewPage(
    await overviewPost("/search", { query, ...accountField(input) }, input),
    "search",
  );
}

/** The exact message a row names, as readable text. Reading does not mark it read. */
export async function openMailMessage(
  input: Auth & { sourceId: string },
): Promise<{ account: string; message: OpenedOverviewMessage }> {
  const root = record(
    await overviewPost("/open", { source_id: input.sourceId, ...accountField(input) }, input),
  );
  const message = record(root?.message);
  const account = typeof root?.account === "string" ? root.account : "";
  const subject = nullableText(message?.subject);
  const sender = nullableText(message?.sender);
  const receivedAt = nullableText(message?.received_at);
  if (
    !account ||
    !message ||
    message.source_id !== input.sourceId ||
    subject === undefined ||
    sender === undefined ||
    receivedAt === undefined ||
    typeof message.body !== "string" ||
    typeof message.body_truncated !== "boolean" ||
    typeof message.unread !== "boolean"
  ) {
    throw malformed();
  }
  return {
    account,
    message: {
      sourceId: input.sourceId,
      subject,
      sender,
      receivedAt,
      unread: message.unread,
      body: message.body,
      bodyTruncated: message.body_truncated,
    },
  };
}

/** A fresh reply reference for this exact message; the body is the person's to write. */
export async function prepareMailReply(
  input: Auth & { sourceId: string },
): Promise<{ account: string; reply: MailReplySource }> {
  const root = record(
    await overviewPost(
      "/reply-source",
      { source_id: input.sourceId, ...accountField(input) },
      input,
    ),
  );
  const reply = record(root?.reply);
  const account = typeof root?.account === "string" ? root.account : "";
  const label = nullableText(reply?.recipient_label);
  if (
    !account ||
    !reply ||
    typeof reply.source_mail_ref !== "string" ||
    !/^rs1\.[A-Za-z0-9_-]{16,2044}$/.test(reply.source_mail_ref) ||
    typeof reply.to !== "string" ||
    !reply.to.trim() ||
    typeof reply.subject !== "string" ||
    typeof reply.expires_in_seconds !== "number" ||
    label === undefined
  ) {
    throw malformed();
  }
  return {
    account,
    reply: {
      sourceMailRef: reply.source_mail_ref,
      to: reply.to.trim(),
      recipientLabel: label,
      subject: reply.subject,
      expiresInSeconds: reply.expires_in_seconds,
    },
  };
}
