// app/api/tickers/all/route.ts

/**
 * Public Ticker Universe Proxy
 *
 * Proxies GET to Python backend: GET /api/tickers/all
 *
 * Used by the Kai stock search to preload the full ticker universe once and
 * search locally on the client.
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
    const refresh = searchParams.get("refresh");
    const backendUrl = getPythonApiUrl();
    const upstream = refresh === "1" || refresh === "true"
      ? `${backendUrl}/api/tickers/all?refresh=1`
      : `${backendUrl}/api/tickers/all`;
    const response = await fetch(upstream, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const data: unknown = await response.json().catch(() => []);

    if (!response.ok) {
      return NextResponse.json(
        { error: getErrorDetail(data) || "Ticker universe fetch failed" },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Tickers all proxy error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
