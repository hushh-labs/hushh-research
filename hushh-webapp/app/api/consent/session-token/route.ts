// app/api/consent/session-token/route.ts

/**
 * Issue Session Token API
 *
 * Proxies to Python backend to issue a session token.
 * Called after passphrase verification.
 *
 * SECURITY: Forwards Firebase ID token for verification.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

const BACKEND_URL = getPythonApiUrl();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId } = body;

    // Get Authorization header from request
    const authHeader = request.headers.get("Authorization");

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }

    if (!authHeader) {
      return NextResponse.json(
        { error: "Authorization header is required" },
        { status: 401 }
      );
    }

    console.log("[API] Issuing session token");

    const response = await fetch(`${BACKEND_URL}/api/consent/issue-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader, // Forward the Firebase ID token
      },
      body: JSON.stringify({ userId, scope: "session" }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("[API] Backend error:", error);
      return NextResponse.json(
        { error: "Failed to issue session token" },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log(`[API] Session token issued, expires at: ${data.expiresAt}`);

    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Session token error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
