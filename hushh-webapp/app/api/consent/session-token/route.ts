// app/api/consent/session-token/route.ts

/**
 * Issue Session Token API
 *
 * Proxies to Python backend to issue a session token.
 *
 * SECURITY (S01 fix): Callers requesting a VAULT_OWNER ("session") token MUST
 * supply passphraseProof — a hex-encoded SHA-256 of the vault key derived
 * client-side via PBKDF2 + AES-GCM decryption of the stored passphrase wrapper
 * (see lib/vault/passphrase-key.ts).  The backend compares this proof against
 * the stored vault_key_hash and rejects requests that omit or mismatch it.
 * Firebase ID token is still required and verified independently.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  invalidJsonPayloadResponse,
  readJsonObject,
} from "@/app/api/_utils/json-body";

const BACKEND_URL = getPythonApiUrl();

export async function POST(request: NextRequest) {
  try {
    const body = (await readJsonObject(request)) as {
      userId?: string;
      passphraseProof?: string;
    } | null;

    if (!body) {
      return invalidJsonPayloadResponse();
    }

    const { userId, passphraseProof } = body;

    // Get Authorization header from request
    const authHeader = request.headers.get("Authorization");

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 },
      );
    }

    if (!authHeader) {
      return NextResponse.json(
        { error: "Authorization header is required" },
        { status: 401 },
      );
    }

    // VAULT_OWNER ("session") scope requires proof of successful vault unlock.
    // Reject early at the proxy layer to avoid a round-trip to the backend.
    if (!passphraseProof) {
      return NextResponse.json(
        {
          error:
            "passphraseProof is required to obtain vault master access. " +
            "Unlock the vault with your passphrase or hardware key first.",
          code: "AUTH_VAULT_PROOF_REQUIRED",
        },
        { status: 403 },
      );
    }

    // Basic format guard: must be a 64-char hex string (SHA-256).
    if (!/^[0-9a-f]{64}$/i.test(passphraseProof)) {
      return NextResponse.json(
        {
          error: "passphraseProof must be a 64-character hex-encoded SHA-256 hash.",
          code: "AUTH_VAULT_PROOF_INVALID_FORMAT",
        },
        { status: 400 },
      );
    }

    console.log("[API] Issuing session token");

    const response = await fetch(`${BACKEND_URL}/api/consent/issue-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader, // Forward the Firebase ID token
      },
      body: JSON.stringify({ userId, scope: "session", passphraseProof }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("[API] Backend error:", error);
      return NextResponse.json(
        { error: "Failed to issue session token" },
        { status: response.status },
      );
    }

    const data = await response.json();
    console.log(`[API] Session token issued, expires at: ${data.expiresAt}`);

    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Session token error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
