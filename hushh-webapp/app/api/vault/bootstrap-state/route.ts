import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { validateFirebaseToken } from "@/lib/auth/validate";
import { isDevelopment } from "@/lib/config";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

export const dynamic = "force-dynamic";

const PYTHON_API_URL = getPythonApiUrl();
const UPSTREAM_TIMEOUT_MS = resolveSlowRequestTimeoutMs(20_000);

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);

  try {
    const body = (await request.json().catch(() => ({}))) as { userId?: string };
    const authHeader = request.headers.get("Authorization");

    if (!authHeader && !isDevelopment()) {
      return withRequestIdJson(
        requestId,
        { error: "Authorization required", code: "AUTH_REQUIRED" },
        { status: 401 }
      );
    }

    if (authHeader) {
      const validation = await validateFirebaseToken(authHeader);
      if (!validation.valid && !isDevelopment()) {
        return withRequestIdJson(
          requestId,
          { error: `Authentication failed: ${validation.error}`, code: "AUTH_INVALID" },
          { status: 401 }
        );
      }
    }

    // Setup admission is mutable security state. A process-local cache cannot
    // be invalidated reliably across server instances, so it must never answer
    // this endpoint with a stale grant or stale incomplete journey. The client
    // owns single-flight/session caching and explicitly refreshes on settlement.
    const response = await fetch(`${PYTHON_API_URL}/db/vault/bootstrap-state`, {
      method: "POST",
      headers: createUpstreamHeaders(requestId, {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      body: JSON.stringify({
        ...(body.userId ? { userId: body.userId } : {}),
      }),
    });

    const payload = await response.json().catch(() => ({}));
    const result = {
      status: response.status,
      payload: response.ok
        ? payload
        : {
            error: payload?.error || payload?.detail || "Backend error",
            ...(typeof payload?.code === "string" ? { code: payload.code } : {}),
            ...(typeof payload?.hint === "string" ? { hint: payload.hint } : {}),
          },
    };

    return withRequestIdJson(requestId, result.payload, { status: result.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} vault_bootstrap_state error:`, error);
    return withRequestIdJson(requestId, { error: "Internal server error" }, { status: 500 });
  }
}
