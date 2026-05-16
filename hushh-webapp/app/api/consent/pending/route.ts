// app/api/consent/pending/route.ts

/**
 * Get Pending Consent Requests API
 *
 * Proxies to Python backend to get pending consent requests for a user.
 * Requires VAULT_OWNER token for authentication (consent-first architecture).
 */

import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { createHotGetJsonCache } from "@/app/api/_utils/hot-get-json-cache";

const BACKEND_URL = getPythonApiUrl();
const pendingCache = createHotGetJsonCache({
  freshTtlMs: 15 * 1000,
  staleTtlMs: 5 * 60 * 1000,
});

function degradedPendingPayload() {
  return {
    pending: [],
    degraded: true,
  };
}

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);

  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return withRequestIdJson(requestId, { error: "userId is required" }, { status: 400 });
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return withRequestIdJson(
        requestId,
        { error: "Authorization header required" },
        { status: 401 }
      );
    }
    const hotCacheKey = `${userId}:${authHeader}`;
    const cached = pendingCache.read(hotCacheKey);
    if (cached) {
      return withRequestIdJson(requestId, cached.payload, { status: cached.status });
    }

    const existing = pendingCache.getInflight(hotCacheKey);
    if (existing) {
      const deduped = await existing;
      return withRequestIdJson(requestId, deduped.payload, { status: deduped.status });
    }

    const load = (async () => {
      const response = await fetch(
        `${BACKEND_URL}/api/consent/pending?userId=${encodeURIComponent(userId)}`,
        {
          method: "GET",
          headers: createUpstreamHeaders(requestId, {
            "Content-Type": "application/json",
            Authorization: authHeader,
          }),
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        console.error(
          `[API] request_id=${requestId} pending_consents backend_error status=${response.status}`,
          error
        );
        if (response.status < 500) {
          return {
            status: response.status,
            payload: { error: error || "Failed to fetch pending consents" },
          };
        }
        throw new Error(`pending_backend_error:${response.status}`);
      }

      return {
        status: response.status,
        payload: await response.json(),
      };
    })();

    pendingCache.setInflight(hotCacheKey, load);
    const result = await load;
    pendingCache.write(hotCacheKey, result);
    return withRequestIdJson(requestId, result.payload, { status: result.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} pending_consents error:`, error);
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");
    const authHeader = request.headers.get("Authorization");
    if (userId && authHeader) {
      const stale = pendingCache.read(`${userId}:${authHeader}`, { allowStale: true });
      if (stale) {
        return withRequestIdJson(requestId, stale.payload, { status: stale.status });
      }
    }
    return withRequestIdJson(requestId, degradedPendingPayload(), { status: 200 });
  } finally {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");
    const authHeader = request.headers.get("Authorization");
    if (userId && authHeader) {
      pendingCache.clearInflight(`${userId}:${authHeader}`);
    }
  }
}
