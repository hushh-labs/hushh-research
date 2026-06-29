// app/api/consent/history/route.ts

/**
 * Consent History API
 *
 * Returns paginated consent audit history for the archived/logs tab.
 *
 * SECURITY: Requires VAULT_OWNER token per BYOK authorization model.
 * The backend validates the token and ensures user_id matches.
 */

import { NextRequest } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";
import { createHotGetJsonCache } from "@/app/api/_utils/hot-get-json-cache";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";

const BACKEND_URL = getPythonApiUrl();
const hotGet = createHotGetJsonCache({
  freshTtlMs: 30 * 1000,
  staleTtlMs: 5 * 60 * 1000,
});

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  try {
    // BYOK Authorization: Require VAULT_OWNER token
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return withRequestIdJson(
        requestId,
        { error: "Authorization header with VAULT_OWNER token required" },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");
    const page = searchParams.get("page") || "1";
    const limit = searchParams.get("limit") || "20";

    if (!userId) {
      return withRequestIdJson(
        requestId,
        { error: "userId is required" },
        { status: 400 }
      );
    }

    const hotCacheKey = `${userId}:${page}:${limit}:${authHeader}`;
    const cached = hotGet.read(hotCacheKey);
    if (cached) {
      return withRequestIdJson(requestId, cached.payload, { status: cached.status });
    }

    const existing = hotGet.getInflight(hotCacheKey);
    if (existing) {
      const deduped = await existing;
      return withRequestIdJson(requestId, deduped.payload, { status: deduped.status });
    }

    const load = (async () => {
      const response = await fetch(
      `${BACKEND_URL}/api/consent/history?userId=${userId}&page=${page}&limit=${limit}`,
      {
        method: "GET",
        headers: createUpstreamHeaders(requestId, {
          Authorization: authHeader,
        }),
        signal: AbortSignal.timeout(10000),
      }
      );

      const payload = await response
        .json()
        .catch(async () => ({ detail: await response.text().catch(() => "") }));
      return {
        status: response.ok ? response.status : response.status,
        payload: response.ok ? payload : { error: "Failed to fetch consent history", detail: payload?.detail || "" },
      };
    })();

    hotGet.setInflight(hotCacheKey, load);
    const result = await load;
    if (result.status < 500) {
      hotGet.write(hotCacheKey, result);
    } else {
      const stale = hotGet.read(hotCacheKey, { allowStale: true });
      if (stale) {
        return withRequestIdJson(requestId, stale.payload, { status: stale.status });
      }
    }
    return withRequestIdJson(requestId, result.payload, { status: result.status });
  } catch (error) {
    console.error("[API] History error:", error);
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");
    const page = searchParams.get("page") || "1";
    const limit = searchParams.get("limit") || "20";
    const authHeader = request.headers.get("Authorization");
    if (userId && authHeader) {
      const stale = hotGet.read(`${userId}:${page}:${limit}:${authHeader}`, { allowStale: true });
      if (stale) {
        return withRequestIdJson(requestId, stale.payload, { status: stale.status });
      }
    }
    return withRequestIdJson(requestId, { error: "Internal server error" }, { status: 500 });
  } finally {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");
    const page = searchParams.get("page") || "1";
    const limit = searchParams.get("limit") || "20";
    const authHeader = request.headers.get("Authorization");
    if (userId && authHeader) {
      hotGet.clearInflight(`${userId}:${page}:${limit}:${authHeader}`);
    }
  }
}
