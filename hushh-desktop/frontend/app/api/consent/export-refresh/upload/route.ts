import { NextRequest, NextResponse } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";

const BACKEND_URL = getPythonApiUrl();

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return NextResponse.json(
        { error: "Authorization header required" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const response = await fetch(`${BACKEND_URL}/api/consent/export-refresh/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify(body),
    });
    const payload = await response
      .json()
      .catch(async () => ({ error: await response.text().catch(() => "") }));
    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    console.error("[API] export-refresh/upload error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
