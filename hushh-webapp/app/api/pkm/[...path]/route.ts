import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";
const METADATA_HOT_GET_FRESH_TTL_MS = 5 * 60 * 1000;
const METADATA_HOT_GET_STALE_TTL_MS = 30 * 60 * 1000;
const PKM_PROXY_TIMEOUT_MS = Number.parseInt(process.env.PKM_PROXY_TIMEOUT_MS ?? "45000", 10);
const PKM_PROXY_WRITE_TIMEOUT_MS = Number.parseInt(
  process.env.PKM_PROXY_WRITE_TIMEOUT_MS ?? "180000",
  10
);

type PkmProxyResult = {
  status: number;
  payload: unknown;
  correlationId?: string | null;
  traceId?: string | null;
};

type PkmMetadataCacheEntry = PkmProxyResult & {
  cachedAt: number;
};

const metadataHotGet = new Map<string, PkmMetadataCacheEntry>();
const metadataHotGetInflight = new Map<string, Promise<PkmProxyResult>>();

function traceHeadersForResult(result: PkmProxyResult): Record<string, string> {
  const responseHeaders: Record<string, string> = {};
  if (result.correlationId) {
    responseHeaders["x-correlation-id"] = result.correlationId;
  }
  if (result.traceId) {
    responseHeaders["x-cloud-trace-context"] = result.traceId;
  }
  return responseHeaders;
}

function readMetadataHotGet(
  key: string,
  options?: { allowStale?: boolean }
): PkmProxyResult | null {
  const cached = metadataHotGet.get(key);
  if (!cached) return null;
  const ageMs = Date.now() - cached.cachedAt;
  const ttlMs = options?.allowStale
    ? METADATA_HOT_GET_STALE_TTL_MS
    : METADATA_HOT_GET_FRESH_TTL_MS;
  if (ageMs > ttlMs) {
    if (options?.allowStale || ageMs > METADATA_HOT_GET_STALE_TTL_MS) {
      metadataHotGet.delete(key);
    }
    return null;
  }
  const { cachedAt: _cachedAt, ...result } = cached;
  return result;
}

function writeMetadataHotGet(key: string, result: PkmProxyResult): void {
  metadataHotGet.set(key, {
    status: result.status,
    payload: result.payload,
    correlationId: result.correlationId,
    traceId: result.traceId,
    cachedAt: Date.now(),
  });
}

function withPkmProxyResult(requestId: string, result: PkmProxyResult) {
  return withRequestIdJson(requestId, result.payload, {
    status: result.status,
    headers: traceHeadersForResult(result),
  });
}

async function proxyPkmRequest(
  request: NextRequest,
  paramsPromise: Promise<{ path: string[] }>,
  method: "GET" | "POST" | "PUT" | "DELETE"
) {
  const requestId = resolveRequestId(request);
  const { path } = await paramsPromise;
  const pathStr = path.join("/");
  const query = request.nextUrl.search;
  const authHeader = request.headers.get("Authorization") || "";
  const hotCacheKey =
    method === "GET" && pathStr.startsWith("metadata/") && authHeader
      ? `${pathStr}${query}:${authHeader}`
      : null;

  try {
    const backendUrl = `${getPythonApiUrl()}/api/pkm/${pathStr}${query}`;
    const headers = createUpstreamHeaders(requestId, {
      ...(authHeader ? { Authorization: authHeader } : {}),
      ...(method === "POST" || method === "PUT"
        ? { "Content-Type": "application/json" }
        : {}),
    });

    const body =
      method === "POST" || method === "PUT"
        ? JSON.stringify(await request.json().catch(() => ({})))
        : undefined;

    if (hotCacheKey) {
      const cached = readMetadataHotGet(hotCacheKey);
      if (cached) {
        return withPkmProxyResult(requestId, cached);
      }

      const existing = metadataHotGetInflight.get(hotCacheKey);
      if (existing) {
        const deduped = await existing;
        return withPkmProxyResult(requestId, deduped);
      }
    }

    const load = (async () => {
      const timeoutMs =
        method === "POST" || method === "PUT" || method === "DELETE"
          ? PKM_PROXY_WRITE_TIMEOUT_MS
          : PKM_PROXY_TIMEOUT_MS;
      const response = await fetch(backendUrl, {
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
        correlationId: response.headers.get("x-correlation-id"),
        traceId:
          response.headers.get("x-cloud-trace-context") ||
          response.headers.get("x-trace-id"),
      };
    })();

    if (hotCacheKey) {
      metadataHotGetInflight.set(hotCacheKey, load);
    }

    const result = await load;
    if (hotCacheKey && result.status < 500) {
      writeMetadataHotGet(hotCacheKey, result);
    } else if (hotCacheKey && result.status >= 500) {
      const stale = readMetadataHotGet(hotCacheKey, { allowStale: true });
      if (stale) {
        return withPkmProxyResult(requestId, stale);
      }
    }

    return withPkmProxyResult(requestId, result);
  } catch (error) {
    console.error(`[PKM API] request_id=${requestId} method=${method} proxy_error`, error);
    if (hotCacheKey) {
      const stale = readMetadataHotGet(hotCacheKey, { allowStale: true });
      if (stale) {
        return withPkmProxyResult(requestId, stale);
      }
    }
    return withRequestIdJson(
      requestId,
      { error: "Failed to proxy request to backend" },
      { status: 500 }
    );
  } finally {
    if (hotCacheKey) {
      metadataHotGetInflight.delete(hotCacheKey);
    }
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyPkmRequest(request, params, "GET");
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyPkmRequest(request, params, "POST");
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyPkmRequest(request, params, "DELETE");
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyPkmRequest(request, params, "PUT");
}
