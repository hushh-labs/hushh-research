import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

const BACKEND_URL = getPythonApiUrl();

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization") || request.headers.get("Authorization");

    if (!authHeader) {
      return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
    }

    const backendUrl = `${BACKEND_URL}/api/account/export`;
    const response = await fetch(backendUrl, {
      method: "GET",
      headers: {
        Authorization: authHeader,
      },
      signal: request.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      await response.body?.cancel();
      return NextResponse.json(
        { error: "Failed to export account data" },
        { status: response.status }
      );
    }

    if (!response.body || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      return NextResponse.json({ error: "Invalid response from backend" }, { status: 502 });
    }

    // Preserve backpressure/cancellation: never text()/parse/stringify this bulk body.
    // The service validates the completed JSON envelope; a broken stream must reject.
    return new Response(response.body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    console.error("[API] Account export proxy failed");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
