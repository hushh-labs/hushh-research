
import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

const BACKEND_URL = getPythonApiUrl();

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

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
      console.error("[API] Backend error:", responseText);
      // Forward the backend's JSON error object intact: the client decides
      // whether the session survives from its machine code (for example the
      // recoverable 409 deprovisioning precondition). Wrapping it in a string
      // hides that code and turns a no-op failure into a forced sign-out.
      const errorPayload = parseJsonObject(responseText) ?? {
        error: responseText || "Failed to delete account",
      };
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
