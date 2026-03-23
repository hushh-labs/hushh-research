// app/api/vault/status/route.ts

/**
 * Vault Status API - Token-Enforced Metadata
 *
 * GET endpoint for checking domain activity status without fetching encrypted data.
 * Returns domain activity metadata (e.g. Kai and PKM domains).
 * Proxies to Python backend /db/vault/status
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

export const dynamic = "force-dynamic";

const PYTHON_API_URL = getPythonApiUrl();

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");
  const consentTokenParam = searchParams.get("consentToken");
  const firebaseAuthHeader = request.headers.get("authorization");
  const consentToken = consentTokenParam;

  if (!firebaseAuthHeader) {
    return NextResponse.json(
      { error: "Missing Authorization header (Firebase ID token required)" },
      { status: 401 }
    );
  }

  if (!userId || !consentToken) {
    return NextResponse.json(
      { error: "userId and consentToken are required" },
      { status: 400 }
    );
  }

  try {
    const response = await fetch(`${PYTHON_API_URL}/db/vault/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: firebaseAuthHeader },
      body: JSON.stringify({ userId, consentToken }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[API] Backend error:", response.status, errorText);
      return NextResponse.json(
        { error: "Backend error", details: errorText },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Vault status fetch error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const userId = body?.userId as string | undefined;
    const consentTokenBody = body?.consentToken as string | undefined;
    const firebaseAuthHeader = request.headers.get("authorization");
    const consentToken = consentTokenBody;

    if (!firebaseAuthHeader) {
      return NextResponse.json(
        { error: "Missing Authorization header (Firebase ID token required)" },
        { status: 401 }
      );
    }

    if (!userId || !consentToken) {
      return NextResponse.json(
        { error: "userId and consentToken are required" },
        { status: 400 }
      );
    }

    const response = await fetch(`${PYTHON_API_URL}/db/vault/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: firebaseAuthHeader },
      body: JSON.stringify({ userId, consentToken }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[API] Backend error:", response.status, errorText);
      return NextResponse.json(
        { error: "Backend error", details: errorText },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Vault status fetch error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
