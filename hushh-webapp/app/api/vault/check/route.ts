// app/api/vault/check/route.ts

/**
 * Check Vault Existence API
 *
 * Legacy-compatible web vault existence check.
 *
 * The public route shape stays `/api/vault/check`, but the web implementation
 * now proxies through the current `/db/vault/bootstrap-state` backend contract
 * so placeholder rows and vault status stay aligned with the modern shell.
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
const VAULT_CHECK_TIMEOUT_MS = Number.parseInt(process.env.VAULT_CHECK_TIMEOUT_MS ?? "30000", 10);

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

    const response = await fetch(`${PYTHON_API_URL}/db/vault/bootstrap-state`, {
      method: "POST",
      headers: createUpstreamHeaders(requestId, {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      }),
      signal: AbortSignal.timeout(
        Number.isFinite(VAULT_CHECK_TIMEOUT_MS) && VAULT_CHECK_TIMEOUT_MS > 0
          ? VAULT_CHECK_TIMEOUT_MS
          : 30000
      ),
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[API] request_id=${requestId} vault_check backend_error status=${response.status}`,
        errorText
      );
      return withRequestIdJson(
        requestId,
        { error: "Backend error", hasVault: false },
        { status: response.status }
      );
    }

    const data = await response.json();

    logSecurityEvent("VAULT_CHECK_SUCCESS", {
      userId,
      exists: data.hasVault,
    });

    return withRequestIdJson(requestId, { hasVault: data.hasVault });
  } catch (error) {
    console.error(`[API] request_id=${requestId} vault_check error:`, error);
    return withRequestIdJson(
      requestId,
      { error: "Failed to check vault status", hasVault: false },
      { status: 500 }
    );
  }
}
