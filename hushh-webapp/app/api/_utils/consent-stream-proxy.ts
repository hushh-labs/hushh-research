import { getPythonApiUrl } from "@/app/api/_utils/backend";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", Vary: "Authorization" };

function failure(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: PRIVATE_HEADERS });
}

/** Only these two authenticated backend streams may be reached by this proxy. */
export async function proxyConsentStream(
  request: Request,
  userId: string,
  stream: "events" | "document-feed",
): Promise<Response> {
  // Next already decoded this segment. Another decoding pass cannot be allowed
  // to change the fixed upstream route.
  if (!userId || userId.length > 128 || userId === "." || userId === ".." ||
      /[\s/\\%?#\u0000-\u001f\u007f]/u.test(userId)) {
    return failure(400, "Invalid userId");
  }
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [^\s]+$/i.test(authorization)) {
    return failure(401, "Sign in to receive updates");
  }
  try {
    const upstream = await fetch(
      `${getPythonApiUrl()}/api/consent/${stream}/${encodeURIComponent(userId)}`,
      {
        method: "GET",
        headers: { Authorization: authorization, "Cache-Control": "no-cache", Connection: "keep-alive" },
        signal: request.signal,
        redirect: "error",
        cache: "no-store",
      },
    );
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      return failure(upstream.status >= 400 ? upstream.status : 502, "Could not connect to consent events stream");
    }
    if (!upstream.body) return failure(502, "No stream body from backend");
    if (upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
      await upstream.body.cancel().catch(() => {});
      return failure(502, "Could not connect to consent events stream");
    }
    return new Response(upstream.body, {
      headers: { ...PRIVATE_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
  } catch {
    // Never reflect private provider errors or response bodies to the client.
    return failure(502, "Could not connect to consent events stream");
  }
}
