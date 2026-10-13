import { getPythonApiUrl } from "@/app/api/_utils/backend";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", Vary: "Authorization" };
// A fixed marker the backend trusts only to end proxied Feed streams before
// this server's request timeout (120 s in production, 300 s in UAT), so they
// rotate cleanly instead of being cut mid-frame.
const STREAM_PROXY_HEADER = "X-Hussh-Stream-Via";
const STREAM_PROXY_VALUE = "next-proxy";
const FEED_PROTOCOL_VERSIONS = new Set(["1", "2"]);

function failure(
  status: number,
  error: string,
  headers: Record<string, string> = {},
  errorCode?: string | null,
): Response {
  const body: { error: string; detail?: { error_code: string } } = { error };
  // The client's permanent-vs-transient reconnect decision keys on this one
  // contract value (events/route.ts -> notification-provider.tsx), never on
  // the upstream's free-text message, so only the enum code crosses the proxy.
  if (errorCode) body.detail = { error_code: errorCode };
  return Response.json(body, { status, headers: { ...PRIVATE_HEADERS, ...headers } });
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
      /[\s/\\%?#\u0000-\u001f\u007f-\u009f]/u.test(userId)) {
    return failure(400, "Invalid userId");
  }
  // Only the Feed stream negotiates frames, and only to a known version; no
  // other query parameter ever reaches the backend.
  let query = "";
  if (stream === "document-feed") {
    const version = new URL(request.url).searchParams.get("v");
    if (version !== null) {
      if (!FEED_PROTOCOL_VERSIONS.has(version)) return failure(400, "Invalid stream version");
      query = `?v=${version}`;
    }
  }
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [^\s]+$/i.test(authorization)) {
    return failure(401, "Sign in to receive updates");
  }
  const headers: Record<string, string> = {
    Authorization: authorization,
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  if (stream === "document-feed") headers[STREAM_PROXY_HEADER] = STREAM_PROXY_VALUE;
  try {
    const upstream = await fetch(
      `${getPythonApiUrl()}/api/consent/${stream}/${encodeURIComponent(userId)}${query}`,
      {
        method: "GET",
        headers,
        signal: request.signal,
        redirect: "error",
        cache: "no-store",
      },
    );
    if (!upstream.ok) {
      // A busy backend says when to come back; pass on only a plain delay.
      const retryAfter = upstream.status === 503 ? upstream.headers.get("retry-after") : null;
      // A 410 on the legacy consent stream is permanent-by-design (SSE is off
      // in production; FCM is primary) and the client only keeps retrying
      // when it CANNOT tell that apart from an expired stream. Read the one
      // enum field that distinguishes them instead of cancelling the body
      // unseen, or every reconnect attempt repeats the same 93s backoff.
      let errorCode: string | null = null;
      if (upstream.status === 410) {
        errorCode = await upstream
          .json()
          .then((body) =>
            typeof body?.detail?.error_code === "string" ? body.detail.error_code : null,
          )
          .catch(() => null);
      } else {
        await upstream.body?.cancel().catch(() => {});
      }
      return failure(
        upstream.status >= 400 ? upstream.status : 502,
        "Could not connect to consent events stream",
        retryAfter && /^\d{1,4}$/.test(retryAfter) ? { "Retry-After": retryAfter } : {},
        errorCode,
      );
    }
    if (!upstream.body) return failure(502, "No stream body from backend");
    if (upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
      await upstream.body.cancel().catch(() => {});
      return failure(502, "Could not connect to consent events stream");
    }
    return new Response(upstream.body, {
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        // next.config compress:true would otherwise hold frames back in gzip.
        "Content-Encoding": "none",
      },
    });
  } catch {
    // Never reflect private provider errors or response bodies to the client.
    return failure(502, "Could not connect to consent events stream");
  }
}
