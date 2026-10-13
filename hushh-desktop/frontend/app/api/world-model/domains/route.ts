// app/api/world-model/domains/route.ts
/**
 * World Model Domains API Route (Web Proxy)
 * 
 * Tri-Flow Layer: Web Proxy (Next.js API route for web platform)
 * Proxies to Python backend: GET /api/world-model/domains
 */

import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const includeEmpty = searchParams.get("include_empty") || "false";

    const response = await fetch(
      `${BACKEND_URL}/api/world-model/domains?include_empty=${includeEmpty}`,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to fetch domains" },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("[world-model/domains] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
