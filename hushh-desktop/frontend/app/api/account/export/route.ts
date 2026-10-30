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

    if (!response.ok) {
      const errorPayload = await response
        .json()
        .catch(async () => ({
          error: (await response.text().catch(() => "")) || "Failed to export account data",
        }));
      console.error("[API] Backend error:", response.status, errorPayload);
      return NextResponse.json(errorPayload, { status: response.status });
    }

    const data = await response.json().catch(() => null);
    if (!data) {
      return NextResponse.json({ error: "Invalid response from backend" }, { status: 502 });
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Account export proxy error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
