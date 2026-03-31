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
        return {
          status: response.status,
          payload: { error: payload?.error || "Backend error" },
        };
      }

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
    return withRequestIdJson(requestId, { error: "Failed to get vault" }, { status: 500 });
  } finally {
    const existing = inflightVaultGet.get(cacheKey);
    if (existing && activeRequest && existing === activeRequest) {
      inflightVaultGet.delete(cacheKey);
    }
  }
}
