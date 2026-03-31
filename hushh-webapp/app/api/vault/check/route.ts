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
import { logSecurityEvent } from "@/lib/config";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

export const dynamic = "force-dynamic";

const PYTHON_API_URL = getPythonApiUrl();
const ROUTE_CACHE_TTL_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = resolveSlowRequestTimeoutMs(20_000);
const vaultCheckCache = new Map<
  string,
  { hasVault: boolean; cachedAt: number }
>();
const vaultCheckInflight = new Map<string, Promise<boolean>>();

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

    if (!authHeader) {
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

    const cached = readFreshVaultCheck(userId);
    if (cached !== null) {
      return withRequestIdJson(requestId, { hasVault: cached, cached: true });
    }

    const existing = vaultCheckInflight.get(userId);
    if (existing) {
      const hasVault = await existing;
      return withRequestIdJson(requestId, { hasVault, deduped: true });
    }

    const load = (async () => {
      const response = await fetch(`${PYTHON_API_URL}/db/vault/check`, {
        method: "POST",
        headers: createUpstreamHeaders(requestId, {
          "Content-Type": "application/json",
          Authorization: authHeader,
        }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[API] request_id=${requestId} vault_check backend_error status=${response.status}`,
          errorText
        );
        throw new Error(`backend_error:${response.status}`);
      }

      const data = await response.json();
      const hasVault = Boolean(data.hasVault);
      writeVaultCheck(userId, hasVault);
      return hasVault;
    })().finally(() => {
      if (vaultCheckInflight.get(userId) === load) {
        vaultCheckInflight.delete(userId);
      }
    });

    vaultCheckInflight.set(userId, load);
    const hasVault = await load;

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
