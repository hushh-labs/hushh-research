// app/api/tickers/sync-holdings/[userId]/route.ts

/**
 * Holdings -> Ticker Master ETL Proxy
 *
 * Proxies POST to Python backend:
 *   POST /api/tickers/sync-holdings/{userId}
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId } = await params;
    const body = await request.json().catch(() => ({}));
    const backendUrl = getPythonApiUrl();
    const response = await fetch(`${backendUrl}/api/tickers/sync-holdings/${encodeURIComponent(userId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: request.headers.get("Authorization") || "",
      },
      body: JSON.stringify(body),
    });

    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      return NextResponse.json(
        { error: getErrorDetail(data) || "Ticker sync failed" },
        { status: response.status }
      );
    }

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("[API] Tickers sync-holdings proxy error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
