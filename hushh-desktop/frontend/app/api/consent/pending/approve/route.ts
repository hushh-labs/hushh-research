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

/**
 * Security and privacy headers stamped on every response from this route.
 * Applied regardless of success or failure status so client-side policies
 * are enforced even when the consent approval is rejected.
 */
const CONSENT_SECURITY_HEADERS: ReadonlyArray<[string, string]> = [
  ["X-Frame-Options",        "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Cache-Control",          "no-store, no-cache, must-revalidate"],
  ["Pragma",                 "no-cache"],
  ["Referrer-Policy",        "strict-origin-when-cross-origin"],
];

function withSecurityHeaders(response: NextResponse): NextResponse {
  for (const [name, value] of CONSENT_SECURITY_HEADERS) {
    response.headers.set(name, value);
  }
  return response;
}

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
      return withSecurityHeaders(NextResponse.json(
        { error: "userId and requestId are required" },
        { status: 400 }
      ));
    }

    if ("exportKey" in body) {
      return withSecurityHeaders(NextResponse.json(
        { error: "Plaintext exportKey is not accepted in strict zero-knowledge mode" },
        { status: 400 }
      ));
    }

    // Forward Authorization header (VAULT_OWNER token)
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return withSecurityHeaders(NextResponse.json(
        { error: "Authorization header required" },
        { status: 401 }
      ));
    }

    console.log(`[API] Approving consent request: ${requestId}`);
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
      const errorText = await response.text();
      console.error("[API] Backend error:", errorText);
      let message = "Failed to approve consent";
      try {
        const parsed = JSON.parse(errorText);
        const detail = parsed?.detail;
        if (typeof detail === "string") {
          message = detail;
        } else if (typeof detail?.message === "string") {
          message = detail.message;
        } else if (typeof parsed?.error === "string") {
          message = parsed.error;
        }
      } catch {
        if (errorText.trim()) {
          message = errorText;
        }
      }
      return withSecurityHeaders(NextResponse.json(
        { error: message },
        { status: response.status }
      ));
    }

    const data = await response.json();
    console.log(`[API] Consent approved with token`);

    return withSecurityHeaders(NextResponse.json(data));
  } catch (error) {
    console.error("[API] Approve consent error:", error);
    return withSecurityHeaders(NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    ));
  }
}
