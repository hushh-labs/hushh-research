import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { createHotGetJsonCache } from "@/app/api/_utils/hot-get-json-cache";
import { validateFirebaseToken } from "@/lib/auth/validate";
import { isDevelopment } from "@/lib/config";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

export const dynamic = "force-dynamic";

const PYTHON_API_URL = getPythonApiUrl();
const UPSTREAM_TIMEOUT_MS = resolveSlowRequestTimeoutMs(20_000);
const hotPost = createHotGetJsonCache({
  freshTtlMs: 30 * 1000,
  staleTtlMs: 5 * 60 * 1000,
});

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);
  let hotCacheKey: string | null = null;

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

    hotCacheKey = authHeader ? `${body.userId || "self"}:${authHeader}` : null;
    if (hotCacheKey) {
      const cached = hotPost.read(hotCacheKey);
      if (cached) {
        return withRequestIdJson(requestId, cached.payload, { status: cached.status });
      }

      const existing = hotPost.getInflight(hotCacheKey);
      if (existing) {
        const deduped = await existing;
        return withRequestIdJson(requestId, deduped.payload, { status: deduped.status });
      }
    }

    const load = (async () => {
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
      return {
        status: response.status,
        payload: response.ok
          ? payload
          : {
              error: payload?.error || payload?.detail || "Backend error",
              ...(typeof payload?.code === "string" ? { code: payload.code } : {}),
              ...(typeof payload?.hint === "string" ? { hint: payload.hint } : {}),
            },
      };
    })();

    if (hotCacheKey) {
      hotPost.setInflight(hotCacheKey, load);
    }

    const result = await load;
    if (hotCacheKey && result.status < 500) {
      hotPost.write(hotCacheKey, result);
    }

    if (hotCacheKey && result.status >= 500) {
      const stale = hotPost.read(hotCacheKey, { allowStale: true });
      if (stale) {
        return withRequestIdJson(requestId, stale.payload, { status: stale.status });
      }
    }

    return withRequestIdJson(requestId, result.payload, { status: result.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} vault_bootstrap_state error:`, error);
    if (hotCacheKey) {
      const stale = hotPost.read(hotCacheKey, { allowStale: true });
      if (stale) {
        return withRequestIdJson(requestId, stale.payload, { status: stale.status });
      }
    }
    return withRequestIdJson(requestId, { error: "Internal server error" }, { status: 500 });
  } finally {
    if (hotCacheKey) {
      hotPost.clearInflight(hotCacheKey);
    }
  }
}
