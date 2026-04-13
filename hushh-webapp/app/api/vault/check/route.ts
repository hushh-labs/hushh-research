// app/api/vault/check/route.ts

/**
 * Check Vault Existence API
 *
 * Legacy-compatible web vault existence check.
 *
 * The public route shape stays `/api/vault/check`, but the web implementation
 * proxies through the dedicated `/db/vault/check` backend contract because
 * this route only needs a fast yes/no existence answer.
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
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

export const dynamic = "force-dynamic";

const PYTHON_API_URL = getPythonApiUrl();
const ROUTE_CACHE_TTL_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = resolveSlowRequestTimeoutMs(20_000);
const vaultCheckCache = new Map<
  string,
  { hasVault: boolean; cachedAt: number }
>();
const vaultCheckInflight = new Map<
  string,
  Promise<{ status: number; payload: { hasVault: boolean; cached?: boolean; degraded?: boolean; error?: string; code?: string; hint?: string } }>
>();

function readFreshVaultCheck(userId: string): boolean | null {
  const cached = vaultCheckCache.get(userId);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > ROUTE_CACHE_TTL_MS) {
    vaultCheckCache.delete(userId);
    return null;
  }
  return cached.hasVault;
}

function writeVaultCheck(userId: string, hasVault: boolean): void {
  vaultCheckCache.set(userId, {
    hasVault,
    cachedAt: Date.now(),
  });
}

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);

  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return withRequestIdJson(requestId, { error: "userId required" }, { status: 400 });
    }

    const authHeader = request.headers.get("Authorization");

    if (!authHeader && !isDevelopment()) {
      logSecurityEvent("VAULT_CHECK_REJECTED", {
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
        logSecurityEvent("VAULT_CHECK_REJECTED", {
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

    const cached = readFreshVaultCheck(userId);
    if (cached !== null) {
      return withRequestIdJson(requestId, { hasVault: cached, cached: true });
    }

    const existing = vaultCheckInflight.get(userId);
    if (existing) {
      const deduped = await existing;
      return withRequestIdJson(
        requestId,
        deduped.status === 200
          ? { ...deduped.payload, deduped: true }
          : deduped.payload,
        { status: deduped.status }
      );
    }

    const load = (async () => {
      const response = await fetch(`${PYTHON_API_URL}/db/vault/check`, {
        method: "POST",
        headers: createUpstreamHeaders(requestId, {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        body: JSON.stringify({ userId }),
      });

      const payload = await response
        .json()
        .catch(async () => ({ error: await response.text().catch(() => "") }));

      if (!response.ok) {
        return {
          status: response.status,
          payload: {
            hasVault: false,
            error:
              typeof payload?.error === "string"
                ? payload.error
                : typeof payload?.detail === "string"
                  ? payload.detail
                  : "Failed to check vault status",
            code:
              typeof payload?.code === "string"
                ? payload.code
                : response.status === 401
                  ? "AUTH_INVALID"
                  : undefined,
            hint: typeof payload?.hint === "string" ? payload.hint : undefined,
          },
        };
      }

      const hasVault = Boolean(payload?.hasVault);
      writeVaultCheck(userId, hasVault);
      return {
        status: 200,
        payload: { hasVault },
      };
    })().finally(() => {
      if (vaultCheckInflight.get(userId) === load) {
        vaultCheckInflight.delete(userId);
      }
    });

    vaultCheckInflight.set(userId, load);
    const result = await load;

    if (result.status !== 200) {
      const cached = readFreshVaultCheck(userId);
      if (result.status >= 500 && cached !== null) {
        return withRequestIdJson(
          requestId,
          { hasVault: cached, degraded: true },
          { status: 200 }
        );
      }
      return withRequestIdJson(requestId, result.payload, { status: result.status });
    }

    const hasVault = result.payload.hasVault;

    logSecurityEvent("VAULT_CHECK_SUCCESS", {
      userId,
      exists: hasVault,
    });

    return withRequestIdJson(requestId, { hasVault });
  } catch (error) {
    console.error(`[API] request_id=${requestId} vault_check error:`, error);
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");
    if (userId) {
      const cached = readFreshVaultCheck(userId);
      if (cached !== null) {
        return withRequestIdJson(
          requestId,
          { hasVault: cached, degraded: true },
          { status: 200 }
        );
      }
    }
    return withRequestIdJson(
      requestId,
      { error: "Failed to check vault status", hasVault: false },
      { status: 504 }
    );
  }
}
