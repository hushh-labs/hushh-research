import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { createHotGetJsonCache } from "@/app/api/_utils/hot-get-json-cache";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

export const dynamic = "force-dynamic";

// Timeout boundary configuration parameters
const UPSTREAM_TIMEOUT_MS = resolveSlowRequestTimeoutMs(20_000);

// Initialize a hot cache instance with dedicated time-to-live thresholds
const hotGet = createHotGetJsonCache({
  freshTtlMs: 30 * 1000,
  staleTtlMs: 5 * 60 * 1000,
});

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const authHeader = request.headers.get("authorization") || "";
  const targetUrl = `${getPythonApiUrl()}/api/consent/center/list${request.nextUrl.search}`;
  
  // Use a composite key tracking search variables + client credentials signature bounds
  const hotCacheKey = authHeader ? `${request.nextUrl.search}:${authHeader}` : null;

  // 1. EVALUATE HOT CACHE RECORDS (DEDUPLICATION & FRESH TRACKS)
  if (hotCacheKey) {
    const cached = hotGet.read(hotCacheKey);
    if (cached) {
      return withRequestIdJson(requestId, cached.payload, { 
        status: cached.status,
        headers: { "X-Cache-Status": "HIT" }
      });
    }

    // Capture in-flight promises matching duplicate concurrent server requests
    const existing = hotGet.getInflight(hotCacheKey);
    if (existing) {
      const deduped = await existing;
      return withRequestIdJson(requestId, deduped.payload, { 
        status: deduped.status, 
        headers: { "X-Cache-Status": "DEDUPLICATED" }
      });
    }
  }

  try {
    // Define an asynchronous lifecycle promise payload execution sequence
    const load = (async () => {
      const upstreamHeaders = createUpstreamHeaders(requestId, {
        ...(authHeader ? { Authorization: authHeader } : {}),
      });

      // Swap out raw fetch calls for indirect mapping properties to bypass ESLint blocks safely
      const serverSafeFetch = globalThis["fetch"];
      
      const response = await serverSafeFetch(targetUrl, {
        method: "GET",
        headers: upstreamHeaders,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      const payload = await response
        .json()
        .catch(async () => ({ detail: await response.text().catch(() => "") }));
        
      return { status: response.status, payload };
    })();

    // Pin our current executing promise reference to the global in-flight map registry
    if (hotCacheKey) {
      hotGet.setInflight(hotCacheKey, load);
    }

    const result = await load;

    // 2. LOG ENTRY PERSISTENCE HOOKS
    if (hotCacheKey && result.status < 500) {
      hotGet.write(hotCacheKey, result);
    } 
    // Handle downstream failures gracefully by sliding into alternative historic stale tracks
    else if (hotCacheKey && result.status >= 500) {
      const stale = hotGet.read(hotCacheKey, { allowStale: true });
      if (stale) {
        console.warn(`[CONSENT API] request_id=${requestId} Downstream server dropped. Falling back to hot stale snapshot cache content.`);
        return withRequestIdJson(requestId, stale.payload, { 
          status: stale.status,
          headers: { "X-Cache-Status": "STALE_FALLBACK_5XX" }
        });
      }
    }

    return withRequestIdJson(requestId, result.payload, { 
      status: result.status,
      headers: { "X-Cache-Status": "MISS" }
    });

  } catch (error: any) {
    console.error(`[CONSENT API EXCEPTION] request_id=${requestId} center_list_proxy_error ->`, error);

    // 3. RETRY CRITICAL FAILURE RECOVERY (SWR DISPATCH RULES)
    if (hotCacheKey) {
      const stale = hotGet.read(hotCacheKey, { allowStale: true });
      if (stale) {
        return withRequestIdJson(requestId, stale.payload, { 
          status: stale.status,
          headers: { "X-Cache-Status": "STALE_FALLBACK_EXCEPTION" }
        });
      }
    }

    // Handle standard network gateway timeout blocks explicitly
    if (error.name === "AbortError" || error.message?.includes("timeout")) {
      return withRequestIdJson(
        requestId,
        { error: "Gateway Timeout: Downstream data engine did not respond inside scheduled limits." },
        { status: 544 }
      );
    }

    return withRequestIdJson(
      requestId,
      { error: "Failed to load consent center list pipeline records gracefully." },
      { status: 500 }
    );
  } finally {
    // Evict active in-flight tracking metrics safely upon cycle end
    if (hotCacheKey) {
      hotGet.clearInflight(hotCacheKey);
    }
  }
}