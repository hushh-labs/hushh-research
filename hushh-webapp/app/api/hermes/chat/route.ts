import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { resolveHermesBridgeConfig } from "@/lib/hermes/bridge-config";
import { resolveRequestId, withRequestIdJson } from "@/app/api/_utils/request-id";

/**
 * One chat turn against the Hermes agent running on this machine.
 *
 * This is a DIFFERENT agent from cloud One: a different model, a different
 * memory, and its work happens on the user's own hardware. That is why the UI
 * gives it its own thread rather than mixing turns into the cloud conversation.
 *
 * The loopback bearer key is injected here, server-side, and never reaches the
 * browser. `onDevice` pins the turn to the local provider so the answer is
 * generated on this machine; the response echoes the provider and model that
 * actually ran, so the surface can prove where the tokens came from instead of
 * asserting it.
 */
export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const config = resolveHermesBridgeConfig();
  if (!config) {
    return withRequestIdJson(
      requestId,
      {
        error: "not_configured",
        message:
          "Set HERMES_API_SERVER_KEY to talk to the Hermes agent on this machine.",
      },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => ({}) as Record<string, unknown>);
  const message = String((body as { message?: unknown }).message || "").trim();
  if (!message) {
    return withRequestIdJson(
      requestId,
      { error: "empty_message", message: "Nothing to send." },
      { status: 400 },
    );
  }
  const sessionId = String((body as { sessionId?: unknown }).sessionId || "").trim();
  const onDevice = Boolean((body as { onDevice?: unknown }).onDevice);

  const upstream: Record<string, unknown> = { message };
  if (onDevice) {
    // Pin generation to the loopback local-model provider so the turn is
    // answered on this machine and nothing reaches a model vendor.
    upstream.provider = "lmstudio";
  }

  // Establish a real Hermes session rather than firing one-off completions.
  // A session is what gives the thread continuity on the agent side: the same
  // transcript, the same memory, and a session id the UI can keep using. A
  // stateless /v1/chat/completions call would answer once and forget, which is
  // not a conversation with the agent, just a query against its model.
  let activeSessionId = sessionId;
  if (!activeSessionId) {
    try {
      const created = await fetch(`${config.baseUrl}/api/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15_000),
      });
      if (created.ok) {
        const session = await created.json().catch(() => ({}));
        activeSessionId = String(
          session?.session_id || session?.id || session?.session?.id || "",
        );
      }
    } catch {
      // Fall through: a turn without a session still answers, it just does not
      // carry continuity. Better a degraded answer than a hard failure.
      activeSessionId = "";
    }
  }

  const path = activeSessionId
    ? `/api/sessions/${encodeURIComponent(activeSessionId)}/chat`
    : "/v1/chat/completions";
  const payload = activeSessionId
    ? upstream
    : {
        model: onDevice ? "local-model" : undefined,
        messages: [{ role: "user", content: message }],
      };

  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      // A local model on a cold load can take a while; this is the user's own
      // hardware, so a generous ceiling is kinder than a spurious timeout.
      signal: AbortSignal.timeout(180_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return withRequestIdJson(
        requestId,
        {
          error: "hermes_error",
          message:
            response.status === 401
              ? "Hermes rejected the local key."
              : "Hermes could not complete that turn.",
        },
        { status: response.status === 401 ? 502 : response.status },
      );
    }
    // Normalize the two shapes (session chat vs OpenAI-compatible) so the UI
    // has one contract, and surface the runtime that actually ran.
    const text =
      data?.message?.content ??
      data?.choices?.[0]?.message?.content ??
      "";
    return withRequestIdJson(
      requestId,
      {
        text: String(text || ""),
        sessionId: data?.session_id || activeSessionId || null,
        runtime: {
          provider: data?.runtime?.provider ?? null,
          model: data?.runtime?.model ?? data?.model ?? null,
        },
      },
      { status: 200 },
    );
  } catch {
    return withRequestIdJson(
      requestId,
      {
        error: "unreachable",
        message: "No Hermes agent is answering on this machine.",
      },
      { status: 503 },
    );
  }
}
