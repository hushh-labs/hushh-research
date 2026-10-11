import { NextRequest } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const init = { headers: { "Cache-Control": "private, no-store" } };
  try {
    const response = await fetch(
      `${getPythonApiUrl()}/api/consent/center/source-fence`,
      {
        cache: "no-store",
        headers: createUpstreamHeaders(requestId, {
          Authorization: request.headers.get("authorization") || "",
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
    const payload = await response.json();
    return withRequestIdJson(requestId, payload, {
      ...init,
      status: response.status,
    });
  } catch {
    return withRequestIdJson(
      requestId,
      { detail: "Consent source inventory unavailable" },
      { ...init, status: 503 },
    );
  }
}
