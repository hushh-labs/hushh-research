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

    const body = await request.json();
    const backendUrl = getPythonApiUrl();

    const response = await fetch(`${backendUrl}/api/notifications/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));
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
