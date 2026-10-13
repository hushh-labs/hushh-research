import { NextRequest, NextResponse } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";

const BACKEND_URL = getPythonApiUrl();

export async function GET(request: NextRequest) {
  try {
    const userId = request.nextUrl.searchParams.get("userId") || "";
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return NextResponse.json(
        { error: "Authorization header required" },
        { status: 401 }
      );
    }

    const response = await fetch(
      `${BACKEND_URL}/api/consent/export-refresh/jobs?userId=${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: authHeader,
        },
      }
    );
    const payload = await response
      .json()
      .catch(async () => ({ error: await response.text().catch(() => "") }));
    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    console.error("[API] export-refresh/jobs error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
