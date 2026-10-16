import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

const HEADERS = { "Cache-Control": "private, no-store", Pragma: "no-cache" };

export async function proxyEmailAuth(request: NextRequest, action: string) {
  // Only same-origin browser JSON may initiate a credential operation.
  const origin = request.headers.get("origin");
  // Next's dev server normalizes nextUrl to localhost even when the browser
  // addresses 127.0.0.1. The HTTP authority retains the browser's actual host.
  let sameOrigin = !origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      sameOrigin = parsed.origin === origin
        && parsed.host === (request.headers.get("host") ?? request.nextUrl.host)
        && (parsed.protocol === "https:" || (parsed.protocol === "http:"
          && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)));
    } catch { sameOrigin = false; }
  }
  if (request.method === "POST" && (
    !sameOrigin ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    !request.headers.get("content-type")?.startsWith("application/json")
  )) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403, headers: HEADERS });
  }
  try {
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && body.length > 2048) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413, headers: HEADERS });
    }
    const upstream = await fetch(`${getPythonApiUrl()}/api/auth/email/${action}`, {
      method: request.method, cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json" },
      ...(body ? { body } : {}),
    });
    return NextResponse.json(await upstream.json(), { status: upstream.status, headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "email_auth_unavailable", message: "Try again shortly." },
      { status: 503, headers: HEADERS });
  }
}
