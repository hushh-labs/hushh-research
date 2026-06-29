
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

    const responseText = await response.text();
    console.log(`[API] Backend response status: ${response.status}`);

    if (!response.ok) {
      console.error("[API] Backend error:", responseText);
      return NextResponse.json(
        { error: responseText || "Failed to delete account" },
        { status: response.status }
      );
    }

    try {
      const data = JSON.parse(responseText);
      return NextResponse.json(data);
    } catch {
      return NextResponse.json({ success: true, raw: responseText });
    }
  } catch (error) {
    console.error("[API] Delete account proxy error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
