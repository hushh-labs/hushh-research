import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { createHotGetJsonCache } from "@/app/api/_utils/hot-get-json-cache";

export const dynamic = "force-dynamic";
const metadataHotGet = createHotGetJsonCache({
  freshTtlMs: 5 * 60 * 1000,
  staleTtlMs: 30 * 60 * 1000,
});

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
      const cached = metadataHotGet.read(hotCacheKey);
      if (cached) {
        return withRequestIdJson(requestId, cached.payload, {
          status: cached.status,
        });
      }

      const existing = metadataHotGet.getInflight(hotCacheKey);
      if (existing) {
        const deduped = await existing;
        return withRequestIdJson(requestId, deduped.payload, {
          status: deduped.status,
        });
      }
    }

    const load = (async () => {
      const response = await fetch(backendUrl, {
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
      metadataHotGet.setInflight(hotCacheKey, load);
    }

    const result = await load;
    if (hotCacheKey && result.status < 500) {
      metadataHotGet.write(hotCacheKey, result);
    } else if (hotCacheKey && result.status >= 500) {
      const stale = metadataHotGet.read(hotCacheKey, { allowStale: true });
      if (stale) {
        return withRequestIdJson(requestId, stale.payload, {
          status: stale.status,
        });
      }
    }

    return withRequestIdJson(requestId, result.payload, {
      status: result.status,
    });
  } catch (error) {
    console.error(`[PKM API] request_id=${requestId} method=${method} proxy_error`, error);
    if (hotCacheKey) {
      const stale = metadataHotGet.read(hotCacheKey, { allowStale: true });
      if (stale) {
        return withRequestIdJson(requestId, stale.payload, {
          status: stale.status,
        });
      }
    }
    return withRequestIdJson(
      requestId,
      { error: "Failed to proxy request to backend" },
      { status: 500 }
    );
  } finally {
    if (hotCacheKey) {
      metadataHotGet.clearInflight(hotCacheKey);
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
