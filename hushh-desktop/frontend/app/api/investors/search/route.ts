import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

const BACKEND_URL = getPythonApiUrl();

/**
 * Proxy for /api/investors/search
 * Public endpoint for investor search (no auth required)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const name = searchParams.get("name");
    const limit = searchParams.get("limit") || "10";

    if (!name) {
      return NextResponse.json(
        { error: "Name parameter required" },
        { status: 400 }
      );
    }

    const response = await fetch(
      `${BACKEND_URL}/api/investors/search?name=${encodeURIComponent(
        name
      )}&limit=${limit}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("[Investors Proxy] Search error:", error);
    return NextResponse.json(
      { error: "Failed to search investors" },
      { status: 500 }
    );
  }
}
