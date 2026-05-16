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
import { proxyRequest } from "@/app/api/_utils/proxy";

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

    return proxyRequest({
      url: `${BACKEND_URL}/api/consent/issue-token`,
      options: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify({
          userId,
          scope: "session",
        }),
      },
      timeoutMessage: "Session token service timed out",
    });
  } catch (error) {
    console.error("[SESSION_TOKEN_API_ERROR]", error);

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}