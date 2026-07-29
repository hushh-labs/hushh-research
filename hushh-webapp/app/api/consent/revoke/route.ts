// app/api/consent/revoke/route.ts

/**
 * Revoke Consent API
 *
 * Revokes an active consent token, removing access for the app.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  invalidJsonPayloadResponse,
  readJsonObject,
} from "@/app/api/_utils/json-body";

const BACKEND_URL = getPythonApiUrl();

/**
 * Scope values this revocation endpoint will act on.
 * Prevents arbitrary or injected strings from reaching the consent service.
 */
const REVOCABLE_SCOPES = [
  "read",
  "write",
  "export",
  "full",
  "analytics",
  "marketing",
  "personalization",
] as const;

export async function POST(request: NextRequest) {
  try {
    const body = (await readJsonObject(request)) as {
      userId?: string;
      scope?: string;
    } | null;
    if (!body) {
      return invalidJsonPayloadResponse();
    }
    const { userId, scope } = body;
    const authHeader =
      request.headers.get("authorization") ||
      request.headers.get("Authorization");

    if (!userId || !scope) {
      return NextResponse.json(
        { error: "userId and scope are required" },
        { status: 400 },
      );
    }

    // ── Scope guard (inline, default-deny) ────────────────────────────────────
    // Validate scope against the known revocable surface before any backend
    // call.  Unrecognised scope values are rejected here so the Python service
    // never receives an arbitrary string it cannot act on.  No helper import.
    if (!(REVOCABLE_SCOPES as readonly string[]).includes(scope)) {
      return NextResponse.json(
        { error: "scope must be one of the recognised revocable consent scopes" },
        { status: 400 },
      );
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (!authHeader) {
      return NextResponse.json(
        { error: "Missing Authorization header" },
        { status: 401 },
      );
    }

    console.log(`[API] Revoking consent for scope: ${scope}`);

    const backendUrl = `${BACKEND_URL}/api/consent/revoke`;
    console.log(`[API] Calling backend: ${backendUrl}`);

    const response = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({ userId, scope }),
    });

    const responseText = await response.text();
    console.log(`[API] Backend response status: ${response.status}`);
    console.log(`[API] Backend response body: ${responseText}`);

    if (!response.ok) {
      console.error("[API] Backend error:", responseText);
      return NextResponse.json(
        { error: responseText || "Failed to revoke consent" },
        { status: response.status },
      );
    }

    // Parse JSON response
    try {
      const data = JSON.parse(responseText);
      return NextResponse.json(data);
    } catch {
      return NextResponse.json({ status: "revoked", raw: responseText });
    }
  } catch (error) {
    console.error("[API] Revoke consent error:", error);
    return NextResponse.json(
      { error: `Internal server error: ${error}` },
      { status: 500 },
    );
  }
}
