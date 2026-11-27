import { NextRequest } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";
import { createUpstreamHeaders, resolveRequestId, withRequestIdJson } from "@/app/api/_utils/request-id";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const headers = { "Cache-Control": "no-store, private", Pragma: "no-cache" };
  let body: unknown;
  try { body = await request.json(); }
  catch { return withRequestIdJson(requestId, { error: "Invalid owner item request" }, { status: 400, headers }); }
  try {
    const response = await fetch(`${getPythonApiUrl()}/api/consent/owner-items/requests`, {
      method: "POST", cache: "no-store",
      headers: createUpstreamHeaders(requestId, { "Content-Type": "application/json", Authorization: request.headers.get("authorization") ?? "" }),
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => ({ error: "Owner item request unavailable" }));
    return withRequestIdJson(requestId, payload, { status: response.status, headers });
  } catch {
    return withRequestIdJson(requestId, { error: "Owner item request unavailable" }, { status: 502, headers });
  }
}
