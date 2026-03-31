import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { createHotGetJsonCache } from "@/app/api/_utils/hot-get-json-cache";

export const dynamic = "force-dynamic";
const UPSTREAM_TIMEOUT_MS = 20_000;
const hotGet = createHotGetJsonCache({
  freshTtlMs: 30 * 1000,
  staleTtlMs: 5 * 60 * 1000,
});

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("authorization") || "";
  const targetUrl = `${getPythonApiUrl()}/api/consent/center/list${request.nextUrl.search}`;
  const hotCacheKey = authHeader ? `${request.nextUrl.search}:${authHeader}` : null;

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

  try {
    const load = (async () => {
      const response = await fetch(targetUrl, {
      method: "GET",
      headers: createUpstreamHeaders(requestId, {
        ...(authHeader ? { Authorization: authHeader } : {}),
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const payload = await response
        .json()
        .catch(async () => ({ detail: await response.text().catch(() => "") }));
      return { status: response.status, payload };
    })();

    if (hotCacheKey) {
      hotGet.setInflight(hotCacheKey, load);
    }
    const result = await load;
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
    console.error(`[CONSENT API] request_id=${requestId} center_list_proxy_error`, error);
    if (hotCacheKey) {
      const stale = hotGet.read(hotCacheKey, { allowStale: true });
      if (stale) {
        return withRequestIdJson(requestId, stale.payload, { status: stale.status });
      }
    }
    return withRequestIdJson(
      requestId,
      { error: "Failed to load consent center list" },
      { status: 500 }
    );
  } finally {
    if (hotCacheKey) {
      hotGet.clearInflight(hotCacheKey);
    }
  }
}
