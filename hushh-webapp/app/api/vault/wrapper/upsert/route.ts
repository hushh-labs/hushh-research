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
      encryptedVaultKey,
      salt,
      iv,
      passkeyCredentialId,
      passkeyPrfSalt,
      passkeyRpId,
      passkeyProvider,
      passkeyDeviceLabel,
      passkeyLastUsedAt,
    } = body as {
      userId?: string;
      vaultKeyHash?: string;
      method?: string;
      wrapperId?: string;
      encryptedVaultKey?: string;
      salt?: string;
      iv?: string;
      passkeyCredentialId?: string;
      passkeyPrfSalt?: string;
      passkeyRpId?: string;
      passkeyProvider?: string;
      passkeyDeviceLabel?: string;
      passkeyLastUsedAt?: number;
    };

    if (!userId || !vaultKeyHash || !method || !encryptedVaultKey || !salt || !iv) {
      return NextResponse.json(
        { error: "Missing required wrapper fields" },
        { status: 400 }
      );
    }

    const authHeader = request.headers.get("Authorization");
    if (authHeader) {
      const validation = await validateFirebaseToken(authHeader);
      if (!validation.valid && !isDevelopment()) {
        return NextResponse.json(
          { error: "Authentication failed", code: "AUTH_INVALID" },
          { status: 401 }
        );
      }
    }

    const clientVersion =
      request.headers.get("x-hushh-client-version") ||
      request.headers.get("x-client-version") ||
      process.env.NEXT_PUBLIC_CLIENT_VERSION ||
      "2.0.0";

    const response = await fetch(`${PYTHON_API_URL}/db/vault/wrapper/upsert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hushh-client-version": clientVersion,
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        userId,
        vaultKeyHash,
        method,
        wrapperId,
        encryptedVaultKey,
        salt,
        iv,
        passkeyCredentialId,
        passkeyPrfSalt,
        passkeyRpId,
        passkeyProvider,
        passkeyDeviceLabel,
        passkeyLastUsedAt,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: errorText || "Backend error" },
        { status: response.status }
      );
    }

    const result = await response.json();
    return NextResponse.json({ success: !!result.success });
  } catch (error) {
    console.error("Vault wrapper upsert error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
