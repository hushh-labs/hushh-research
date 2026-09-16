/**
 * Single-use ticket for the One Live Voice socket.
 *
 * `POST /api/one/voice/sessions` is the only place the vault-owner bearer is
 * used for voice; the ticket it returns is the only token that ever rides in
 * a URL (`?ticket=`), it lives 60 s, and it is consumed on first use. The
 * bearer itself and the Firebase proof go in the first socket frame instead
 * (see lib/one-voice/live-client.ts).
 */

import { Capacitor } from "@capacitor/core";

import { ApiService } from "@/lib/services/api-service";

export type VoiceClientKind = "web" | "ios" | "android";

export type VoiceTicket = {
  ticket: string;
  /** Unix epoch seconds, as issued by the backend. */
  expiresAt: number;
  sessionId: string;
  wsPath: string;
};

export type VoiceUnavailableReason =
  | "disabled"
  | "not_configured"
  | "backend_origin_missing"
  | "auth_missing"
  | "unauthorized"
  | "invalid_conversation"
  | "rate_limited"
  | "capacity"
  | "provider_unavailable"
  | "network"
  | "timeout"
  | "closed"
  | "unknown";

const REASON_MESSAGES: Record<VoiceUnavailableReason, string> = {
  disabled: "Voice is not available.",
  not_configured: "Voice is not configured.",
  backend_origin_missing: "Voice needs a backend origin to connect to.",
  auth_missing: "Sign in and unlock your vault to use voice.",
  unauthorized: "Voice could not verify your sign-in.",
  invalid_conversation: "This voice conversation is not valid.",
  rate_limited: "Voice is busy. Try again in a moment.",
  capacity: "Voice is busy right now.",
  provider_unavailable: "Voice is unavailable right now.",
  network: "Voice could not reach the server.",
  timeout: "Voice took too long to connect.",
  closed: "Voice was closed.",
  unknown: "Voice is unavailable right now.",
};

export class VoiceUnavailableError extends Error {
  readonly reason: VoiceUnavailableReason;
  readonly status: number | null;
  readonly code: string | null;

  constructor(
    reason: VoiceUnavailableReason,
    options: {
      message?: string;
      status?: number | null;
      code?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(
      options.message || REASON_MESSAGES[reason],
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "VoiceUnavailableError";
    this.reason = reason;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

export function isVoiceUnavailableError(
  error: unknown,
): error is VoiceUnavailableError {
  return error instanceof VoiceUnavailableError;
}

/** The `client` the backend records for the session: the running platform. */
export function detectVoiceClientKind(): VoiceClientKind {
  const platform = Capacitor.getPlatform();
  if (platform === "ios") return "ios";
  if (platform === "android") return "android";
  return "web";
}

const DEFAULT_WS_PATH = "/api/one/voice/live";

function readDetailCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const detail = (body as { detail?: unknown }).detail;
  if (detail && typeof detail === "object") {
    const code = (detail as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return typeof detail === "string" ? detail : null;
}

function reasonForStatus(
  status: number,
  code: string | null,
): VoiceUnavailableReason {
  if (code === "ONE_VOICE_LIVE_DISABLED") return "disabled";
  if (code === "ONE_VOICE_NOT_CONFIGURED") return "not_configured";
  if (code === "CONVERSATION_ID_INVALID") return "invalid_conversation";
  if (status === 404) return "disabled";
  if (status === 503) return "not_configured";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 422) return "invalid_conversation";
  if (status === 429) return "rate_limited";
  return "unknown";
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseTicket(body: unknown): VoiceTicket | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const ticket = typeof record.ticket === "string" ? record.ticket.trim() : "";
  const sessionId =
    typeof record.session_id === "string" ? record.session_id.trim() : "";
  const expiresAt =
    typeof record.expires_at === "number"
      ? record.expires_at
      : Number(record.expires_at);
  const wsPath =
    typeof record.ws_path === "string" && record.ws_path.startsWith("/")
      ? record.ws_path
      : DEFAULT_WS_PATH;
  if (!ticket || !sessionId || !Number.isFinite(expiresAt)) return null;
  return { ticket, expiresAt, sessionId, wsPath };
}

/**
 * Mint a ticket for one socket open. Throws `VoiceUnavailableError` with a
 * typed reason: the backend's 404 (flag off) maps to `disabled`, its 503 (no
 * config / no ticket secret) to `not_configured`.
 */
export async function mintVoiceTicket(input: {
  vaultOwnerToken: string;
  conversationId: string;
  client: VoiceClientKind;
}): Promise<VoiceTicket> {
  const vaultOwnerToken = String(input.vaultOwnerToken || "").trim();
  const conversationId = String(input.conversationId || "").trim();
  if (!vaultOwnerToken) throw new VoiceUnavailableError("auth_missing");
  if (conversationId.length !== 36)
    throw new VoiceUnavailableError("invalid_conversation");

  let response: Response;
  try {
    response = await ApiService.apiFetch("/api/one/voice/sessions", {
      method: "POST",
      headers: ApiService.getAuthHeaders(vaultOwnerToken),
      body: JSON.stringify({
        conversation_id: conversationId,
        client: input.client,
      }),
    });
  } catch (error) {
    throw new VoiceUnavailableError("network", { cause: error });
  }

  const body = await readJson(response);
  if (!response.ok) {
    const code = readDetailCode(body);
    throw new VoiceUnavailableError(reasonForStatus(response.status, code), {
      status: response.status,
      code,
    });
  }
  const ticket = parseTicket(body);
  if (!ticket) {
    throw new VoiceUnavailableError("unknown", {
      status: response.status,
      message: "Voice ticket response was malformed.",
    });
  }
  return ticket;
}
