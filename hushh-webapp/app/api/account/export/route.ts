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
    });

    const responseText = await response.text();
    if (!response.ok) {
      return NextResponse.json(
        { error: responseText || "Failed to export account data" },
        { status: response.status }
      );
    }

    try {
      return NextResponse.json(JSON.parse(responseText));
    } catch {
      return NextResponse.json({ success: true, raw: responseText });
    }
  } catch (error) {
    console.error("[API] Account export proxy error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
