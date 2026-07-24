// app/api/notifications/unregister/route.ts

/**
 * Unregister push notification token(s) (FCM/APNs)
 *
 * Proxies DELETE to Python backend. Requires Firebase ID token in Authorization.
 * Body: { user_id, platform?: "web" | "ios" | "android" }
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

export const dynamic = "force-dynamic";

async function safeParseResponse(response: Response) {
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "");
    return text ? { detail: text } : {};
  }

  try {
    return await response.json();
  } catch {
    const text = await response.text().catch(() => "");
    return text ? { detail: text } : {};
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization");

    if (!authHeader) {
      return NextResponse.json(
        { error: "Authorization header required" },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => null);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }

    const backendUrl = getPythonApiUrl();

    const response = await fetch(
      `${backendUrl}/api/notifications/unregister`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(body),
      }
    );

    const data = await safeParseResponse(response);

    if (!response.ok) {
      return NextResponse.json(
        data?.detail
          ? { error: data.detail }
          : { error: "Failed to unregister token" },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Notifications unregister error:", error);

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}