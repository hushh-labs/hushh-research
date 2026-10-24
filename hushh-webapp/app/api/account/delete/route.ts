
import { NextRequest } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";
import { createUpstreamHeaders, resolveRequestId, withRequestIdJson } from "@/app/api/_utils/request-id";

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
  const requestId = resolveRequestId(request);
  try {
    const authHeader = request.headers.get("authorization") || request.headers.get("Authorization");
    const requestBody = await request.text();

    if (!authHeader) {
      return withRequestIdJson(requestId,
        { error: "Missing Authorization header" },
        { status: 401 }
      );
    }

    const backendUrl = `${BACKEND_URL}/api/account/delete`;
    console.log(`[API] Proxying account deletion to: ${backendUrl}`);

    const response = await fetch(backendUrl, {
      method: "DELETE",
      headers: createUpstreamHeaders(requestId, {
        "Content-Type": "application/json",
        Authorization: authHeader,
      }),
      body: requestBody || undefined,
    });

    const responseText = await response.text();
    console.log(`[API] Backend response status: ${response.status}`);

    if (!response.ok) {
      console.warn("[API] Account deletion refused", { requestId, status: response.status });
      // Forward the backend's JSON error object intact: the client decides
      // whether the session survives from its machine code (for example the
      // recoverable 409 deprovisioning precondition). Wrapping it in a string
      // hides that code and turns a no-op failure into a forced sign-out.
      const errorPayload = parseJsonObject(responseText) ?? {
        error: responseText || "Failed to delete account",
      };
      return withRequestIdJson(requestId, errorPayload, { status: response.status, headers: { "Cache-Control": "private, no-store", ...(response.headers.get("Retry-After") ? { "Retry-After": response.headers.get("Retry-After")! } : {}) } });
    }

    try {
      const data = JSON.parse(responseText);
      const retryAfter = response.headers.get("Retry-After");
      return withRequestIdJson(requestId, data, {
        status: response.status,
        headers: { "Cache-Control": "private, no-store", ...(retryAfter ? { "Retry-After": retryAfter } : {}) },
      });
    } catch {
      return withRequestIdJson(requestId, { success: true, raw: responseText });
    }
  } catch (error) {
    console.error("[API] Delete account proxy error", { requestId, errorType: error instanceof Error ? error.name : "unknown" });
    return withRequestIdJson(requestId,
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
