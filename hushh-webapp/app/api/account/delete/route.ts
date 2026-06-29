
import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

const BACKEND_URL = getPythonApiUrl();

export async function DELETE(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization") || request.headers.get("Authorization");
    const requestBody = await request.text();

    if (!authHeader) {
      return NextResponse.json(
        { error: "Missing Authorization header" },
        { status: 401 }
      );
    }

    const backendUrl = `${BACKEND_URL}/api/account/delete`;
    console.log(`[API] Proxying account deletion to: ${backendUrl}`);

    const response = await fetch(backendUrl, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: requestBody || undefined,
    });

    if (!response.ok) {
      const errorPayload = await response
        .json()
        .catch(async () => ({
          error: (await response.text().catch(() => "")) || "Failed to delete account",
        }));
      console.error("[API] Backend error:", response.status, errorPayload);
      return NextResponse.json(errorPayload, { status: response.status });
    }

    const data = await response.json().catch(() => ({ success: true }));
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Delete account proxy error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
