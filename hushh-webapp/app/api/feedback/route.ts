import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);

  try {
    const authorization = request.headers.get("authorization");
    if (!authorization) {
      return withRequestIdJson(
        requestId,
        { error: "Missing Authorization header" },
        { status: 401 }
      );
    }

    const response = await fetch(`${getPythonApiUrl()}/api/feedback`, {
      method: "POST",
      headers: createUpstreamHeaders(requestId, {
        Authorization: authorization,
        "Content-Type": "application/json",
      }),
      body: await request.text(),
    });

    const data = await response.json().catch(() => ({
      error: "Feedback request failed",
    }));

    return withRequestIdJson(requestId, data, { status: response.status });
  } catch (error) {
    console.error("[API] Feedback proxy error:", error);
    return withRequestIdJson(
      requestId,
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
