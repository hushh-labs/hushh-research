import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";

// Rule 3: Fail-Fast Boundary Contract
// Validate backend infrastructure routes immediately at the module level on load
const BACKEND_API_URL = getPythonApiUrl();
if (!BACKEND_API_URL) {
  throw new Error("[Marketplace API] Initialization Error: Python API base URL is missing or undefined.");
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const requestId = resolveRequestId(request);

  try {
    const { path } = await params;

    // Ensure path arrays exist safely before operations
    if (!path || !Array.isArray(path)) {
      return withRequestIdJson(
        requestId,
        { error: "Invalid dynamic path parameter structure" },
        { status: 400 }
      );
    }

    const pathStr = path.join("/");
    const query = request.nextUrl.search;
    const targetUrl = `${BACKEND_API_URL}/api/marketplace/${pathStr}${query}`;

    const response = await fetch(targetUrl, {
      method: "GET",
      headers: createUpstreamHeaders(requestId),
    });

    // Rule 4: Type Compliance on fallback logic
    const payload = await response
      .json()
      .catch(async (_jsonError: unknown) => ({
        detail: await response.text().catch((_textError: unknown) => "")
      }));

    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch (_error: unknown) {
    // Rule 4: Explicit type usage & proper linter prefixing for localizing errors safely
    console.error(`[Marketplace API] request_id=${requestId} proxy_error`, _error);

    return withRequestIdJson(
      requestId,
      { error: "Failed to proxy marketplace request" },
      { status: 500 }
    );
  }
}