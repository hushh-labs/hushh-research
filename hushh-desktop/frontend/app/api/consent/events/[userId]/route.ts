// app/api/consent/events/[userId]/route.ts

/**
 * Consent SSE Events Proxy
 *
 * Proxies GET /api/consent/events/:userId to the Python backend and streams
 * Server-Sent Events (consent_update, heartbeat) to the client.
 *
 * Required so that on web (same-origin), EventSource("/api/consent/events/:userId")
 * hits this route instead of 404.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId } = await params;
  if (!userId) {
    return NextResponse.json(
      { error: "userId is required" },
      { status: 400 }
    );
  }

  const backendUrl = getPythonApiUrl();
  const sseUrl = `${backendUrl}/api/consent/events/${userId}`;
  const authorization = request.headers.get("authorization");

  try {
    const backendResponse = await fetch(sseUrl, {
      method: "GET",
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...(authorization ? { Authorization: authorization } : {}),
      },
    });

    if (!backendResponse.ok) {
      const responseText = await backendResponse.text();
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(responseText) as Record<string, unknown>;
      } catch {
        payload = {
          error: "Failed to connect to consent events stream",
          backendMessage: responseText || undefined,
        };
      }
      console.error("[API] Consent SSE backend error", backendResponse.status);
      return NextResponse.json(
        payload,
        { status: backendResponse.status }
      );
    }

    if (!backendResponse.body) {
      return NextResponse.json(
        { error: "No stream body from backend" },
        { status: 502 }
      );
    }

    return new Response(backendResponse.body, {
      status: 200,
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("[API] Consent SSE proxy error");
    if (process.env.NODE_ENV !== "production") {
      console.error(error);
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
