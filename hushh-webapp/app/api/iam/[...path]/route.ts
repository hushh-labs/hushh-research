import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";

const HOT_GET_CACHE_TTL_MS = 30 * 1000;
const HOT_GET_STALE_TTL_MS = 10 * 60 * 1000;
const hotGetCache = new Map<string, { status: number; payload: unknown; cachedAt: number }>();
const hotGetInflight = new Map<string, Promise<{ status: number; payload: unknown }>>();

function readHotGetCache(
  key: string,
  options?: { allowStale?: boolean }
): { status: number; payload: unknown } | null {
  const cached = hotGetCache.get(key);
  if (!cached) return null;
  const ageMs = Date.now() - cached.cachedAt;
  const ttlMs = options?.allowStale ? HOT_GET_STALE_TTL_MS : HOT_GET_CACHE_TTL_MS;
  if (ageMs > ttlMs) {
    hotGetCache.delete(key);
    return null;
  }
  return {
    status: cached.status,
    payload: cached.payload,
  };
}

function writeHotGetCache(key: string, value: { status: number; payload: unknown }): void {
  hotGetCache.set(key, {
    ...value,
    cachedAt: Date.now(),
  });
}

async function proxyRequest(
  request: NextRequest,
  params: { path: string[] },
  method: "GET" | "POST"
) {
  const requestId = resolveRequestId(request);
  const query = request.nextUrl.search;
  const path = params.path.join("/");
  const targetUrl = `${getPythonApiUrl()}/api/iam/${path}${query}`;
  const authHeader = request.headers.get("authorization") || "";
  const hotCacheKey =
    method === "GET" && path === "persona" && authHeader
      ? `${path}:${authHeader}`
      : null;

  const headers = createUpstreamHeaders(requestId, {
    ...(authHeader ? { Authorization: authHeader } : {}),
    ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
  });

  const body = method === "POST" ? JSON.stringify(await request.json().catch(() => ({}))) : undefined;

  if (hotCacheKey) {
    const cached = readHotGetCache(hotCacheKey);
    if (cached) {
      return withRequestIdJson(requestId, cached.payload, {
        status: cached.status,
      });
    }

    const existing = hotGetInflight.get(hotCacheKey);
    if (existing) {
      const deduped = await existing;
      return withRequestIdJson(requestId, deduped.payload, {
        status: deduped.status,
      });
    }
  }

  try {
    const load = (async () => {
      const response = await fetch(targetUrl, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(20000),
      });
      const payload = await response
        .json()
        .catch(async () => ({ detail: await response.text().catch(() => "") }));

      return {
        status: response.status,
        payload,
      };
    })();

    if (hotCacheKey) {
      hotGetInflight.set(hotCacheKey, load);
    }

    const result = await load;

    if (hotCacheKey && result.status < 500) {
      writeHotGetCache(hotCacheKey, result);
    }

    if (hotCacheKey && result.status >= 500) {
      const stale = readHotGetCache(hotCacheKey, { allowStale: true });
      if (stale) {
        console.warn(
          `[IAM API] request_id=${requestId} serving stale persona cache after upstream ${result.status}`
        );
        return withRequestIdJson(requestId, stale.payload, {
          status: stale.status,
        });
      }
    }

    return withRequestIdJson(requestId, result.payload, {
      status: result.status,
    });
  } catch (error) {
    console.error(`[IAM API] request_id=${requestId} proxy_error`, error);
    if (hotCacheKey) {
      const stale = readHotGetCache(hotCacheKey, { allowStale: true });
      if (stale) {
        console.warn(
          `[IAM API] request_id=${requestId} serving stale persona cache after proxy failure`
        );
        return withRequestIdJson(requestId, stale.payload, {
          status: stale.status,
        });
      }
    }
    return withRequestIdJson(
      requestId,
      {
        error: "Failed to proxy IAM request",
        detail: error instanceof Error ? error.message : "unknown_error",
      },
      { status: 504 }
    );
  } finally {
    if (hotCacheKey) {
      hotGetInflight.delete(hotCacheKey);
    }
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, await params, "GET");
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, await params, "POST");
}
