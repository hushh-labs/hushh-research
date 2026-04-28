import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";
const HOT_GET_CACHE_TTL_MS = 30 * 1000;
const DEFAULT_PROXY_TIMEOUT_MS = 12_000;
const ONBOARDING_PROXY_TIMEOUT_MS = Number(
  process.env.RIA_ONBOARDING_PROXY_TIMEOUT_MS || 90_000
);
const hotGetCache = new Map<string, { status: number; payload: unknown; cachedAt: number }>();
const hotGetInflight = new Map<string, Promise<{ status: number; payload: unknown }>>();

function readHotGetCache(key: string): { status: number; payload: unknown } | null {
  const cached = hotGetCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > HOT_GET_CACHE_TTL_MS) {
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

function resolveProxyTimeoutMs(path: string, method: "GET" | "POST"): number {
  if (
    method === "POST" &&
    (
      path.startsWith("onboarding/submit") ||
      path.startsWith("onboarding/dev-activate") ||
      path.startsWith("onboarding/verify-name")
    )
  ) {
    return ONBOARDING_PROXY_TIMEOUT_MS;
  }
  return DEFAULT_PROXY_TIMEOUT_MS;
}

function isTimeoutError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "string") {
    return error.includes("TimeoutError") || error.includes("aborted due to timeout");
  }
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  if (candidate.name === "TimeoutError") return true;
  if (candidate.code === 23) return true;
  const text = String(candidate.message || error);
  return text.includes("TimeoutError") || text.includes("aborted due to timeout");
}

async function proxyRequest(
  request: NextRequest,
  params: { path: string[] },
  method: "GET" | "POST"
) {
  const requestId = resolveRequestId(request);
  const path = params.path.join("/");
  const timeoutMs = resolveProxyTimeoutMs(path, method);
  const query = request.nextUrl.search;
  const targetUrl = `${getPythonApiUrl()}/api/ria/${path}${query}`;

  const authHeader = request.headers.get("authorization") || "";
  const hotCacheKey =
    method === "GET" && path === "onboarding/status" && authHeader
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
        signal: AbortSignal.timeout(timeoutMs),
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

    return withRequestIdJson(requestId, result.payload, {
      status: result.status,
    });
  } catch (error) {
    console.error(`[RIA API] request_id=${requestId} proxy_error path=${path}`, error);
    if (isTimeoutError(error)) {
      return withRequestIdJson(
        requestId,
        {
          error: "RIA request timed out while waiting for backend verification.",
          code: "RIA_PROXY_TIMEOUT",
          timeout_ms: timeoutMs,
          path,
        },
        { status: 504 }
      );
    }
    return withRequestIdJson(
      requestId,
      { error: "Failed to proxy RIA request" },
      { status: 500 }
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
