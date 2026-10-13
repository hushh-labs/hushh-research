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
import { validateFirebaseToken } from "@/lib/auth/validate";
import { isDevelopment, logSecurityEvent } from "@/lib/config";

export const dynamic = "force-dynamic";

const PYTHON_API_URL = getPythonApiUrl();
const VAULT_GET_TIMEOUT_MS = Number.parseInt(
  process.env.VAULT_GET_TIMEOUT_MS ?? "12000",
  10
);
const inflightVaultGet = new Map<string, Promise<{ status: number; payload: unknown }>>();
const ROUTE_CACHE_TTL_MS = 60 * 1000;
const ROUTE_STALE_CACHE_TTL_MS = 5 * 60 * 1000;
const vaultGetCache = new Map<
  string,
  { status: number; payload: unknown; cachedAt: number }
>();

function readVaultGetCache(
  cacheKey: string,
  options?: { allowStale?: boolean }
): { status: number; payload: unknown } | null {
  const cached = vaultGetCache.get(cacheKey);
  if (!cached) return null;
  const maxAgeMs = options?.allowStale ? ROUTE_STALE_CACHE_TTL_MS : ROUTE_CACHE_TTL_MS;
  if (Date.now() - cached.cachedAt > maxAgeMs) {
    vaultGetCache.delete(cacheKey);
    return null;
  }
  return {
    status: cached.status,
    payload: cached.payload,
  };
}

function writeVaultGetCache(cacheKey: string, value: { status: number; payload: unknown }): void {
  vaultGetCache.set(cacheKey, {
    ...value,
    cachedAt: Date.now(),
  });
}

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  let activeRequest: Promise<{ status: number; payload: unknown }> | null = null;

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");

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

  if (authHeader) {
    const validation = await validateFirebaseToken(authHeader);

    if (!validation.valid) {
      logSecurityEvent("VAULT_KEY_REJECTED", {
        reason: validation.error,
        userId,
      });
      return withRequestIdJson(
        requestId,
        {
          error: `Authentication failed: ${validation.error}`,
          code: "AUTH_INVALID",
        },
        { status: 401 }
      );
    }
  }

  const cacheKey = `${userId}:${authHeader || "no-auth"}`;

  try {
    const cached = readVaultGetCache(cacheKey);
    if (cached) {
      return withRequestIdJson(requestId, cached.payload, { status: cached.status });
    }

    const existing = inflightVaultGet.get(cacheKey);
    if (existing) {
      const deduped = await existing;
      return withRequestIdJson(requestId, deduped.payload, { status: deduped.status });
    }

    const load = (async () => {
      const response = await fetch(`${PYTHON_API_URL}/db/vault/get`, {
        method: "POST",
        headers: createUpstreamHeaders(requestId, {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        }),
        body: JSON.stringify({ userId }),
        signal: AbortSignal.timeout(VAULT_GET_TIMEOUT_MS),
      });

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
          `[API] request_id=${requestId} vault_get backend_error status=${response.status}`,
          payload
        );
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
          payload: { error: payload?.error || "Backend error" },
        };
      }

      writeVaultGetCache(cacheKey, {
        status: response.status,
        payload,
      });
      return {
        status: response.status,
        payload,
      };
    })();

    activeRequest = load;
    inflightVaultGet.set(cacheKey, load);
    const result = await load;
    if (result.status < 400) {
      logSecurityEvent("VAULT_KEY_SUCCESS", { userId });
    }
    return withRequestIdJson(requestId, result.payload, { status: result.status });
  } catch (error) {
    console.error(`[API] request_id=${requestId} vault_get error:`, error);
    const stale = readVaultGetCache(cacheKey, { allowStale: true });
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
    const existing = inflightVaultGet.get(cacheKey);
    if (existing && activeRequest && existing === activeRequest) {
      inflightVaultGet.delete(cacheKey);
    }
  }
}
