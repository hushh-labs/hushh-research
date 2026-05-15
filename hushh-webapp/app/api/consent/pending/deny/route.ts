// app/api/consent/pending/deny/route.ts

/**
 * Deny Pending Consent Request API
 *
 * User denies a pending consent request from a developer.
 * Requires VAULT_OWNER token for authentication (consent-first architecture).
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

const BACKEND_URL = getPythonApiUrl();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId, requestId } = body;

    if (!userId || !requestId) {
      return NextResponse.json(
        { error: "userId and requestId are required" },
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

    console.log(`[API] Denying consent request: ${requestId}`);

    const response = await fetch(
      `${BACKEND_URL}/api/consent/pending/deny?userId=${userId}&requestId=${requestId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("[API] Backend error:", error);
      return NextResponse.json(
        { error: "Failed to deny consent" },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log(`[API] Consent denied: ${JSON.stringify(data)}`);

    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Deny consent error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
