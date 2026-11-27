import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader) {
      return NextResponse.json({ detail: "Authorization required" }, { status: 401 });
    }
    const backendUrl = `${getPythonApiUrl()}/api/consent/history/clear-system-logs`;
    const response = await fetch(backendUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });
    const text = await response.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { detail: text || "Upstream error" };
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("[api/consent/history/clear-system-logs] Proxy error:", error);
    return NextResponse.json({ detail: "Failed to clear system logs" }, { status: 500 });
  }
}
