// app/api/consent/pending/approve/route.ts

/**
 * Approve Pending Consent Request API (Zero-Knowledge)
 *
 * User approves a consent request. Browser decrypts data, re-encrypts with
 * export key, and sends encrypted payload. Server never sees plaintext.
 * Requires VAULT_OWNER token for authentication (consent-first architecture).
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

const BACKEND_URL = getPythonApiUrl();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      userId,
      requestId,
      encryptedData,
      encryptedIv,
      encryptedTag,
      wrappedExportKey,
      wrappedKeyIv,
      wrappedKeyTag,
      senderPublicKey,
      wrappingAlg,
      connectorKeyId,
      sourceContentRevision,
      sourceManifestRevision,
      durationHours,
    } = body;

    if (!userId || !requestId) {
      return NextResponse.json(
        { error: "userId and requestId are required" },
        { status: 400 }
      );
    }

    if ("exportKey" in body) {
      return NextResponse.json(
        { error: "Plaintext exportKey is not accepted in strict zero-knowledge mode" },
        { status: 400 }
      );
    }

    // Forward Authorization header (VAULT_OWNER token)
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return NextResponse.json(
        { error: "Authorization header required" },
        { status: 401 }
      );
    }

    console.log(`[API] User ${userId} approving consent request: ${requestId}`);
    console.log(`[API] Export data present: ${!!encryptedData}`);

    // Forward to FastAPI with encrypted export
    const response = await fetch(`${BACKEND_URL}/api/consent/pending/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({
        userId,
        requestId,
        encryptedData,
        encryptedIv,
        encryptedTag,
        wrappedExportKey,
        wrappedKeyIv,
        wrappedKeyTag,
        senderPublicKey,
        wrappingAlg,
        connectorKeyId,
        sourceContentRevision,
        sourceManifestRevision,
        durationHours,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("[API] Backend error:", error);
      return NextResponse.json(
        { error: "Failed to approve consent" },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log(`[API] Consent approved with token`);

    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Approve consent error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
