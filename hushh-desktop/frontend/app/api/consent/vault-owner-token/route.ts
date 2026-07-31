// app/api/consent/vault-owner-token/route.ts
/**
 * Issue VAULT_OWNER consent token for authenticated vault owner.
 *
 * Web platform: Proxies to Python backend /api/consent/vault-owner-token
 * Native platforms use Capacitor plugin directly (bypass this route)
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

export const dynamic = "force-dynamic";

const BACKEND_URL = getPythonApiUrl();

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return NextResponse.json(
        { error: "Missing Authorization header" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { userId } = body;

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }

    // Proxy to Python backend
    const response = await fetch(
      `${BACKEND_URL}/api/consent/vault-owner-token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify({ userId }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[API] Backend error:", response.status, errorText);
      return NextResponse.json(
        { error: "Failed to issue VAULT_OWNER token" },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] VAULT_OWNER token error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
