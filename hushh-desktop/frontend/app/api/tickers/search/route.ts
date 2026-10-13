// app/api/tickers/search/route.ts

/**
 * Public Ticker Search Proxy
 *
 * Proxies GET to Python backend: GET /api/tickers/search?q=...&limit=...
 * This keeps web builds (and dev) aligned with the backend, while mobile
 * can still call the backend directly via ApiService when native.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

export const dynamic = "force-dynamic";

function getErrorDetail(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("detail" in data)) {
    return null;
  }
  const detail = (data as { detail?: unknown }).detail;
  return typeof detail === "string" ? detail : null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q") || "";
    const limit = searchParams.get("limit") || "25";

    if (!q.trim()) {
      return NextResponse.json([], { status: 200 });
    }

    const backendUrl = getPythonApiUrl();
    const response = await fetch(
      `${backendUrl}/api/tickers/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const data: unknown = await response.json().catch(() => []);

    if (!response.ok) {
      return NextResponse.json(
        { error: getErrorDetail(data) || "Ticker search failed" },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Tickers search proxy error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
