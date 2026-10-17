import { NextRequest, NextResponse } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import { forwardVaultBackendError } from "@/app/api/vault/_utils/backend-error";
import { validateFirebaseToken } from "@/lib/auth/validate";
import { devAuthBypassAllowed } from "@/lib/config";
import { VAULT_WRITE_PROTOCOL_VERSION } from "@/lib/vault/write-protocol-version";

export const dynamic = "force-dynamic";

const PYTHON_API_URL = getPythonApiUrl();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      userId,
      vaultKeyHash,
      method,
      wrapperId,
      fallbackPrimaryMethod,
      fallbackPrimaryWrapperId,
    } = body as {
      userId?: string;
      vaultKeyHash?: string;
      method?: string;
      wrapperId?: string;
      fallbackPrimaryMethod?: string;
      fallbackPrimaryWrapperId?: string;
    };

    if (!userId || !vaultKeyHash || !method) {
      return NextResponse.json(
        { error: "Missing required wrapper delete fields" },
        { status: 400 },
      );
    }

    const vaultOwnerHeader = request.headers.get("X-Hushh-Consent");
    if (!vaultOwnerHeader) {
      return NextResponse.json(
        {
          error: "Vault unlock proof required",
          code: "VAULT_OWNER_TOKEN_REQUIRED",
        },
        { status: 401 },
      );
    }
    const normalizedVaultOwnerHeader = vaultOwnerHeader.startsWith("Bearer ")
      ? vaultOwnerHeader
      : `Bearer ${vaultOwnerHeader}`;

    const authHeader = request.headers.get("Authorization");
    if (authHeader) {
      const validation = await validateFirebaseToken(authHeader);
      if (!validation.valid && !devAuthBypassAllowed()) {
        return NextResponse.json(
          { error: "Authentication failed", code: "AUTH_INVALID" },
          { status: 401 },
        );
      }
    }

    const vaultWriteProtocolVersion =
      request.headers.get("x-hushh-client-version") ||
      request.headers.get("x-client-version") ||
      VAULT_WRITE_PROTOCOL_VERSION;

    const response = await fetch(`${PYTHON_API_URL}/db/vault/wrapper/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hushh-client-version": vaultWriteProtocolVersion,
        "X-Hushh-Consent": normalizedVaultOwnerHeader,
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        userId,
        vaultKeyHash,
        method,
        wrapperId,
        fallbackPrimaryMethod,
        fallbackPrimaryWrapperId,
      }),
    });

    if (!response.ok) {
      return forwardVaultBackendError(response);
    }

    const result = await response.json();
    return NextResponse.json({ success: !!result.success });
  } catch (error) {
    console.error("Vault wrapper delete error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
