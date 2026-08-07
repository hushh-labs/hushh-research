/**
 * Server-side client for `hushh-mail-api`.
 *
 * The API key authorises sending under the Hussh Workspace SPF and DKIM identity, so it stays on the
 * server: this module must never be imported from a client component, and the
 * route handlers that use it never echo the key or the endpoint back.
 *
 * One sends rendered `subject` + `html` rather than a registered template id.
 * The registry covers cross-project shapes (invitation, notification,
 * verification); One's lifecycle copy is product-specific and lives with the
 * product, while the transport, key model, idempotency and rate limiting stay
 * with the service.
 */

import "server-only";

import { resolveMailApiEndpoint, resolveMailApiKey } from "@/lib/runtime/settings";

const SEND_TIMEOUT_MS = 10_000;

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** A retry with the same key does not send twice. */
  idempotencyKey?: string;
}

export type SendMailResult =
  | { status: "sent"; messageId: string | null; deduplicated: boolean }
  | { status: "not_configured" }
  | { status: "failed"; reason: string };

/** True when both the endpoint and a key are bound. Never logs either value. */
export function isMailConfigured(): boolean {
  return Boolean(resolveMailApiEndpoint() && resolveMailApiKey());
}

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const endpoint = resolveMailApiEndpoint();
  const apiKey = resolveMailApiKey();

  // Fail open, not closed: a missing binding must never break a sign-in. The
  // caller decides how loudly to report it.
  if (!endpoint || !apiKey) return { status: "not_configured" };

  const to = String(input.to ?? "").trim();
  if (!to) return { status: "failed", reason: "missing_recipient" };

  try {
    const response = await fetch(`${endpoint}/v1/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        to,
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      messageId?: string;
      deduplicated?: boolean;
      error?: string;
    };

    if (!response.ok) {
      // `error` from the mail service describes the request, not the key.
      return {
        status: "failed",
        reason: payload?.error ? String(payload.error) : `http_${response.status}`,
      };
    }

    return {
      status: "sent",
      messageId: payload?.messageId ?? null,
      deduplicated: payload?.deduplicated === true,
    };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "send_failed",
    };
  }
}
