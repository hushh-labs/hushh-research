import { NextRequest, NextResponse } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import { validateFirebaseToken } from "@/lib/auth/validate";
import { isDevelopment } from "@/lib/config";

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
      if (!validation.valid && !isDevelopment()) {
        return NextResponse.json(
          { error: "Authentication failed", code: "AUTH_INVALID" },
          { status: 401 },
        );
      }
    }

    const clientVersion =
      request.headers.get("x-hushh-client-version") ||
      request.headers.get("x-client-version") ||
      process.env.NEXT_PUBLIC_CLIENT_VERSION ||
      "2.0.0";

    const response = await fetch(`${PYTHON_API_URL}/db/vault/wrapper/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hushh-client-version": clientVersion,
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
      const errorPayload = await response
        .json()
        .catch(async () => ({ error: await response.text().catch(() => "") }));
      return NextResponse.json(errorPayload, { status: response.status });
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
