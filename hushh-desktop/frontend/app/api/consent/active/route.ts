// app/api/consent/active/route.ts

/**
 * Active Consents API
 *
 * Returns active (non-expired) consent tokens for the session tab.
 */

import { NextRequest } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";
import { createHotGetJsonCache } from "@/app/api/_utils/hot-get-json-cache";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

const BACKEND_URL = getPythonApiUrl();
const hotGet = createHotGetJsonCache({
  freshTtlMs: 30 * 1000,
  staleTtlMs: 5 * 60 * 1000,
});

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return withRequestIdJson(
        requestId,
        { error: "userId is required" },
        { status: 400 }
      );
    }

    const authorization = request.headers.get("Authorization");
    const hotCacheKey = authorization ? `${userId}:${authorization}` : null;

    if (hotCacheKey) {
      const cached = hotGet.read(hotCacheKey);
      if (cached) {
        return withRequestIdJson(requestId, cached.payload, { status: cached.status });
      }

      const existing = hotGet.getInflight(hotCacheKey);
      if (existing) {
        const deduped = await existing;
        return withRequestIdJson(requestId, deduped.payload, { status: deduped.status });
      }
    }

    const load = (async () => {
      const response = await fetch(
      `${BACKEND_URL}/api/consent/active?userId=${userId}`,
      {
        method: "GET",
        headers: createUpstreamHeaders(requestId, {
          ...(authorization ? { Authorization: authorization } : {}),
          "Content-Type": "application/json",
        }),
        signal: AbortSignal.timeout(10000),
      }
      );

      const payload = await response
        .json()
        .catch(async () => ({ detail: await response.text().catch(() => "") }));
      return {
        status: response.ok ? response.status : response.status,
        payload: response.ok ? payload : { error: "Failed to fetch active consents", detail: payload?.detail || "" },
      };
    })();

    if (hotCacheKey) {
      hotGet.setInflight(hotCacheKey, load);
    }
    const result = await load;

    // ── Inline timeline verification (default-deny) ───────────────────────────
    // Secondary enforcement layer: inspect every item in a 200 payload for a
    // passed expires_at before the response reaches the client.  This catches
    // backend filter misses and clock-skew edge cases.
    //
    // Guard is based solely on expires_at — the token's actual duration
    // metadata — so longer-lived grants (durationHours up to 8 760) are
    // never incorrectly expired.  Items without an expires_at are treated as
    // still-valid and pass through unchanged.
    //
    // Numbers are treated as Unix epoch SECONDS (standard FastAPI output)
    // and converted to milliseconds for comparison.  ISO strings use
    // Date.parse().
    if (result.status === 200) {
      const items = (result.payload as Record<string, unknown>)?.items;
      if (Array.isArray(items)) {
        const now = Date.now();
        const toMs = (v: unknown): number | null => {
          if (v == null) return null;
          const n = typeof v === "number" ? v * 1_000 : Date.parse(String(v));
          return Number.isFinite(n) ? n : null;
        };
        const expired = (items as Array<Record<string, unknown>>).some(item => {
          const expiresMs = toMs(item["expires_at"]);
          return expiresMs !== null && expiresMs <= now;
        });
        if (expired) {
          const body = {
            error: "Active consent session has expired. Re-authentication required.",
          };
          if (hotCacheKey) hotGet.write(hotCacheKey, { status: 401, payload: body });
          return withRequestIdJson(requestId, body, { status: 401 });
        }
      }
    }
    // ── End timeline verification ─────────────────────────────────────────────

    if (hotCacheKey && result.status < 500) {
      hotGet.write(hotCacheKey, result);
    } else if (hotCacheKey && result.status >= 500) {
      const stale = hotGet.read(hotCacheKey, { allowStale: true });
      if (stale) {
        return withRequestIdJson(requestId, stale.payload, { status: stale.status });
      }
    }
    return withRequestIdJson(requestId, result.payload, { status: result.status });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[API] Active consents error:", error);
    }
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");
    const authHeader = request.headers.get("Authorization");
    if (userId && authHeader) {
      const stale = hotGet.read(`${userId}:${authHeader}`, { allowStale: true });
      if (stale) {
        return withRequestIdJson(requestId, stale.payload, { status: stale.status });
      }
    }
    return withRequestIdJson(requestId, { error: "Internal server error" }, { status: 500 });
  } finally {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");
    const authHeader = request.headers.get("Authorization");
    if (userId && authHeader) {
      hotGet.clearInflight(`${userId}:${authHeader}`);
    }
  }
}
