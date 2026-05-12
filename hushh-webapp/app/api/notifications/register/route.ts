// app/api/notifications/register/route.ts

/**
 * Register push notification token (FCM/APNs)
 *
 * Proxies POST to Python backend. Requires Firebase ID token in Authorization.
 * Body: { user_id, token, platform: "web" | "ios" | "android" }
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return NextResponse.json(
        { error: "Authorization header required" },
        { status: 401 }
      );
    }

    // 1. Read raw text to avoid unnecessary JSON parse/stringify cycle
    const bodyText = await request.text().catch(() => "");
    const backendUrl = getPythonApiUrl();

    const response = await fetch(`${backendUrl}/api/notifications/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: bodyText || undefined,
      cache: "no-store", // Ensure Next.js doesn't cache this proxy call
    });

    // 2. Safely parse the upstream response (handles 204 No Content or text errors)
    const responseText = await response.text();
    let data;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = { detail: responseText };
    }

    if (!response.ok) {
      return NextResponse.json(
        data?.detail ? { error: data.detail } : { error: "Failed to register token" },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Notifications register error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}