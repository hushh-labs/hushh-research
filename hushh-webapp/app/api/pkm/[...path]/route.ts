import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { createHotGetJsonCache } from "@/app/api/_utils/hot-get-json-cache";
import { CURRENT_PKM_MODEL_VERSION } from "@/lib/personal-knowledge-model/upgrade-contracts";

export const dynamic = "force-dynamic";
const metadataHotGet = createHotGetJsonCache({
  freshTtlMs: 5 * 60 * 1000,
  staleTtlMs: 30 * 60 * 1000,
});
const PKM_PROXY_TIMEOUT_MS = Number.parseInt(process.env.PKM_PROXY_TIMEOUT_MS ?? "45000", 10);
const PKM_PROXY_WRITE_TIMEOUT_MS = Number.parseInt(
  process.env.PKM_PROXY_WRITE_TIMEOUT_MS ?? "180000",
  10
);

type PkmProxyResult = {
  status: number;
  payload: unknown;
  correlationId: string | null;
  traceId: string | null;
  emptyState?: "pkm-metadata" | "pkm-domain-data";
};

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function emptyMetadataPayload(pathStr: string) {
  const encodedUserId = pathStr.slice("metadata/".length).split("/")[0] || "";
  const userId = decodePathSegment(encodedUserId);
  return {
    user_id: userId,
    domains: [],
    total_attributes: 0,
    model_completeness: 0,
    model_version: CURRENT_PKM_MODEL_VERSION,
    stored_model_version: CURRENT_PKM_MODEL_VERSION,
    effective_model_version: CURRENT_PKM_MODEL_VERSION,
    target_model_version: CURRENT_PKM_MODEL_VERSION,
    upgrade_status: "current",
    upgradable_domains: [],
    last_upgraded_at: null,
    suggested_domains: [],
    last_updated: null,
  };
}

function emptyDomainDataPayload() {
  return {
    encrypted_blob: null,
    storage_mode: "domain",
    data_version: null,
    updated_at: null,
    manifest_revision: null,
    segment_ids: [],
  };
}

function normalizeEmptyPkmGet(
  method: "GET" | "POST" | "PUT" | "DELETE",
  pathStr: string,
  result: PkmProxyResult
): PkmProxyResult {
  if (method !== "GET" || result.status !== 404) {
    return result;
  }
  if (pathStr.startsWith("metadata/")) {
    return {
      ...result,
      status: 200,
      payload: emptyMetadataPayload(pathStr),
      emptyState: "pkm-metadata",
    };
  }
  if (pathStr.startsWith("domain-data/")) {
    return {
      ...result,
      status: 200,
      payload: emptyDomainDataPayload(),
      emptyState: "pkm-domain-data",
    };
  }
  return result;
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

    const load = (async (): Promise<PkmProxyResult> => {
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
      metadataHotGet.setInflight(hotCacheKey, load);
    }

    const result = normalizeEmptyPkmGet(method, pathStr, await load);
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

    const responseHeaders: Record<string, string> = {};
    if (result.correlationId) {
      responseHeaders["x-correlation-id"] = result.correlationId;
    }
    if (result.traceId) {
      responseHeaders["x-cloud-trace-context"] = result.traceId;
    }
    if (result.emptyState) {
      responseHeaders["x-hushh-empty-state"] = result.emptyState;
    }
    return withRequestIdJson(requestId, result.payload, {
      status: result.status,
      headers: responseHeaders,
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
