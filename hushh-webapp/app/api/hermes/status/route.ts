import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { resolveHermesBridgeConfig } from "@/lib/hermes/bridge-config";
import { resolveRequestId, withRequestIdJson } from "@/app/api/_utils/request-id";

/**
 * Liveness and model of the Hermes agent running on this machine.
 *
 * Server-side only: the loopback bearer key stays here and never reaches the
 * browser. "Not configured" and "not reachable" are ordinary states, not
 * errors -- the toggle uses them to stay disabled with an honest reason rather
 * than offering a session that cannot exist.
 */
export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const config = resolveHermesBridgeConfig();
  if (!config) {
    return withRequestIdJson(
      requestId,
      {
        connected: false,
        reason: "not_configured",
        message:
          "Set HERMES_API_SERVER_KEY to talk to the Hermes agent on this machine.",
      },
      { status: 200 },
    );
  }

  try {
    const response = await fetch(`${config.baseUrl}/health/detailed`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      return withRequestIdJson(
        requestId,
        {
          connected: false,
          reason: response.status === 401 ? "unauthorized" : "unhealthy",
          message:
            response.status === 401
              ? "Hermes rejected the local key."
              : "Hermes is running but not healthy.",
        },
        { status: 200 },
      );
    }
    const payload = await response.json().catch(() => ({}));
    // The gateway reports its configured model at the top level (`model`,
    // `provider`); readiness only carries a status per check. Older builds
    // nested the name under readiness. Read every shape rather than showing a
    // connected agent with no model, which is what the header did before.
    const model =
      payload?.model ||
      payload?.readiness?.model?.configured_model ||
      payload?.readiness?.checks?.model?.configured_model ||
      null;
    return withRequestIdJson(
      requestId,
      {
        connected: true,
        model,
        provider: payload?.provider ?? null,
        busy: Boolean(payload?.gateway_busy),
        activeAgents: payload?.active_agents ?? null,
        version: payload?.version ?? null,
      },
      { status: 200 },
    );
  } catch {
    // A closed loopback port is the normal "agent not running" case.
    return withRequestIdJson(
      requestId,
      {
        connected: false,
        reason: "unreachable",
        message: "No Hermes agent is answering on this machine.",
      },
      { status: 200 },
    );
  }
}
