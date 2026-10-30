import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";

const BACKEND_URL = getPythonApiUrl();

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return withRequestIdJson(
      requestId,
      { error: "Authorization header required" },
      { status: 401 }
    );
  }

  try {
    const response = await fetch(`${BACKEND_URL}/api/consent/data`, {
      method: "GET",
      headers: createUpstreamHeaders(requestId, {
        Authorization: authorization,
        Accept: "application/json",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response
      .json()
      .catch(async () => ({ detail: await response.text().catch(() => "") }));
    return withRequestIdJson(requestId, payload, { status: response.status });
  } catch {
    return withRequestIdJson(
      requestId,
      {
        error: "Consent export unavailable",
        message: "The encrypted consent export could not be loaded right now.",
      },
      { status: 504 }
    );
  }
}
