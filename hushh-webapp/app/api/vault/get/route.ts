// app/api/vault/get/route.ts

/**
 * Get Vault Key Metadata API
 *
 * SYMMETRIC WITH NATIVE:
 * This route proxies to Python backend /db/vault/get
 * to maintain consistency with iOS/Android native plugins.
 *
 * Native (Swift/Kotlin): POST /db/vault/get -> Python
 * Web (Next.js): GET /api/vault/get -> Python (proxy)
 */

import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import { isDevelopment, logSecurityEvent } from "@/lib/config";
import { AUTH_ACCOUNT_NOT_FOUND_BACKEND_CODE } from "@/lib/auth/session-invalidation";
import { VaultStateReadCache, type VaultStateRead } from "@/lib/vault/vault-state-read-cache";
import {
  isRequestTimeoutError,
  resolveSlowRequestTimeoutMs,
} from "@/lib/utils/request-timeouts";

export const dynamic = "force-dynamic";

const PYTHON_API_URL = getPythonApiUrl();
const VAULT_GET_TIMEOUT_MS = Number.parseInt(
  process.env.VAULT_GET_TIMEOUT_MS ?? `${resolveSlowRequestTimeoutMs(12_000)}`,
  10
);
// Extended budget for the single retry, sized to absorb a cold backend /
// database connection pool warm-up (which has been observed to take tens of
// seconds on the first request after idle).
const VAULT_GET_RETRY_TIMEOUT_MS = Number.parseInt(
  process.env.VAULT_GET_RETRY_TIMEOUT_MS ?? `${resolveSlowRequestTimeoutMs(45_000)}`,
  10
);
const ROUTE_CACHE_TTL_MS = 60 * 1000;
const ROUTE_STALE_CACHE_TTL_MS = 5 * 60 * 1000;
type VaultGetResult = { status: number; payload: unknown };
const vaultReads = new VaultStateReadCache<VaultGetResult>(
  ROUTE_CACHE_TTL_MS,
  ROUTE_STALE_CACHE_TTL_MS,
);

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  let activeRead: VaultStateRead<VaultGetResult> | null = null;

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");
  // A security-sensitive read (e.g. an unlock attempt) must never decrypt
  // against metadata this proxy cached before a wrapper changed elsewhere.
  const bypassCache = searchParams.get("fresh") === "1";

  if (!userId) {
    return withRequestIdJson(requestId, { error: "userId required" }, { status: 400 });
  }

  const authHeader = request.headers.get("Authorization");

  if (!authHeader && !isDevelopment()) {
    logSecurityEvent("VAULT_KEY_REJECTED", {
      reason: "No auth header",
      userId,
    });
    return withRequestIdJson(
      requestId,
      { error: "Authorization required", code: "AUTH_REQUIRED" },
      { status: 401 }
    );
  }

  // The Python vault route is the authority for Firebase token verification
  // and the token/user match. Re-verifying the bearer in this proxy requires
  // an independently configured Firebase Admin SDK, which makes a valid
  // browser session look like a failed passphrase unlock in local runtimes.
  // Preserve the bearer unchanged so the backend performs the single check.

  const cacheKey = `${userId}:${authHeader || "no-auth"}`;

  try {
    const cached = bypassCache ? null : vaultReads.getCached(cacheKey);
    if (cached) {
      return withRequestIdJson(requestId, cached.payload, { status: cached.status });
    }

    // A client invalidation is invisible to this proxy. Every forced read must
    // start after it, rather than joining an earlier ordinary or forced read.
    const existing = bypassCache ? undefined : vaultReads.getPending(cacheKey);
    if (existing) {
      const deduped = await existing;
      return withRequestIdJson(requestId, deduped.payload, { status: deduped.status });
    }

    const read = vaultReads.begin(cacheKey, bypassCache);
    activeRead = read;
    const load = (async () => {
      // Cold backends (first request after idle / a fresh deploy) can take well
      // over a single short timeout to answer because the DB connection pool is
      // still warming up. A single hard timeout there turns a slow-but-healthy
      // backend into a user-facing 503. So we attempt twice: a first try with
      // the normal timeout, then one retry with a longer timeout that absorbs
      // the cold start. Only timeouts and 5xx responses are
      // retried; 4xx and 404 are returned immediately.
      const attempt = async (timeoutMs: number) =>
        fetch(`${PYTHON_API_URL}/db/vault/get`, {
          method: "POST",
          headers: createUpstreamHeaders(requestId, {
            "Content-Type": "application/json",
            ...(authHeader ? { Authorization: authHeader } : {}),
          }),
          body: JSON.stringify({ userId }),
          signal: AbortSignal.timeout(timeoutMs),
        });

      let response: Response;
      try {
        response = await attempt(VAULT_GET_TIMEOUT_MS);
        // Retry once on a server error: a cold backend often answers the
        // second time once the pool is warm.
        if (response.status >= 500) {
          console.warn(
            `[API] request_id=${requestId} vault_get backend ${response.status}; retrying with extended timeout`
          );
          response = await attempt(VAULT_GET_RETRY_TIMEOUT_MS);
        }
      } catch (firstError) {
        // The first attempt timed out (or the connection dropped). Retry once
        // with a longer budget that covers the cold start before giving up.
        if (isRequestTimeoutError(firstError)) {
          console.warn(
            `[API] request_id=${requestId} vault_get timed out after ${VAULT_GET_TIMEOUT_MS}ms; retrying with extended timeout`
          );
          response = await attempt(VAULT_GET_RETRY_TIMEOUT_MS);
        } else {
          throw firstError;
        }
      }

      if (response.status === 404) {
        return {
          status: 404,
          payload: { error: "Vault not found" },
        };
      }

      const payload = await response
        .json()
        .catch(async () => ({ error: await response.text().catch(() => "Backend error") }));

      if (!response.ok) {
        console.error(
          `[API] request_id=${requestId} vault_get backend_error status=${response.status}`
        );
        if (response.status === 401 && (
          payload?.code === AUTH_ACCOUNT_NOT_FOUND_BACKEND_CODE ||
          payload?.detail?.code === AUTH_ACCOUNT_NOT_FOUND_BACKEND_CODE
        )) {
          vaultReads.invalidate(cacheKey);
          return { status: 401, payload: {
            error: "Account not found", code: AUTH_ACCOUNT_NOT_FOUND_BACKEND_CODE,
          } };
        }
        if (response.status >= 500) {
          return {
            status: 503,
            payload: {
              error: "Vault is temporarily unavailable",
              code: "VAULT_TEMPORARILY_UNAVAILABLE",
            },
          };
        }
        return {
          status: response.status,
          payload: { error: response.status === 401 ? "Authorization required" : payload?.error || "Backend error" },
        };
      }

      vaultReads.publish(read, {
        status: response.status,
        payload,
      });
      return {
        status: response.status,
        payload,
      };
    })();

    vaultReads.track(read, load);
    const result = await load;
    if (result.status < 400) {
      logSecurityEvent("VAULT_KEY_SUCCESS", { userId });
    }
    return withRequestIdJson(requestId, result.payload, { status: result.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} vault_get error:`, error);
    const stale = bypassCache ? null : vaultReads.getCached(cacheKey, { allowStale: true });
    if (stale) {
      return withRequestIdJson(
        requestId,
        { ...(stale.payload as Record<string, unknown>), degraded: true },
        { status: stale.status }
      );
    }
    return withRequestIdJson(
      requestId,
      {
        error: "Vault is temporarily unavailable",
        code: "VAULT_TEMPORARILY_UNAVAILABLE",
      },
      { status: 503 }
    );
  } finally {
    if (activeRead) vaultReads.finish(activeRead);
  }
}
