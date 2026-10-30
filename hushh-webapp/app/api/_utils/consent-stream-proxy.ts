import { getPythonApiUrl } from "@/app/api/_utils/backend";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", Vary: "Authorization" };
// A fixed marker the backend trusts only to end proxied notification streams before
// this server's request timeout (120 s in production, 300 s in UAT), so they
// rotate cleanly instead of being cut mid-frame.
const STREAM_PROXY_HEADER = "X-Hussh-Stream-Via";
const STREAM_PROXY_VALUE = "next-proxy";
const FEED_PROTOCOL_VERSIONS = new Set(["1", "2"]);

function failure(status: number, error: string, headers: Record<string, string> = {}, errorCode?: string): Response {
  return Response.json(
    { error, ...(errorCode ? { detail: { error_code: errorCode } } : {}) },
    { status, headers: { ...PRIVATE_HEADERS, ...headers } },
  );
}

/**
 * Only the discriminator, never the upstream message or body: a disabled-flag
 * code like CONSENT_SSE_DISABLED is safe and deliberate, not a private error.
 */
function upstreamErrorCode(body: unknown): string | undefined {
  const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : undefined;
  if (!detail || typeof detail !== "object") return undefined;
  const { error_code: code, code: legacyCode } = detail as { error_code?: unknown; code?: unknown };
  // Feed admission uses `code`; project only its closed, content-free reason.
  return typeof code === "string" ? code : legacyCode === "FEED_STREAM_BUSY" ? legacyCode : undefined;
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
  // Forward only known protocol negotiation and capability discovery flags.
  let query = "";
  let capabilities = false;
  if (stream === "document-feed") {
    const version = new URL(request.url).searchParams.get("v");
    if (version !== null) {
      if (!FEED_PROTOCOL_VERSIONS.has(version)) return failure(400, "Invalid stream version");
      query = `?v=${version}`;
    }
  } else {
    const discovery = new URL(request.url).searchParams.get("capabilities");
    if (discovery !== null) {
      if (discovery !== "1") return failure(400, "Invalid capability discovery");
      capabilities = true;
      query = "?capabilities=1";
    }
  }
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [^\s]+$/i.test(authorization)) {
    return failure(401, "Sign in to receive updates");
  }
  const upstreamAbort = new AbortController();
  const abortUpstream = () => upstreamAbort.abort();
  if (request.signal.aborted) abortUpstream();
  else request.signal.addEventListener("abort", abortUpstream, { once: true });
  const releaseRequest = () => {
    request.signal.removeEventListener("abort", abortUpstream);
    abortUpstream();
  };
  const headers: Record<string, string> = {
    Authorization: authorization,
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  headers[STREAM_PROXY_HEADER] = STREAM_PROXY_VALUE;
  try {
    const upstream = await fetch(
      `${getPythonApiUrl()}/api/consent/${stream}/${encodeURIComponent(userId)}${query}`,
      {
        method: "GET",
        headers,
        signal: upstreamAbort.signal,
        redirect: "error",
        cache: "no-store",
      },
    );
    if (!upstream.ok) {
      // The discriminator decides whether the client ever retries (e.g.
      // CONSENT_SSE_DISABLED on a 410 is permanent), so it must survive this
      // hop even though the rest of the upstream body never does.
      let errorCode: string | undefined;
      try {
        const text = await upstream.text();
        errorCode = text ? upstreamErrorCode(JSON.parse(text)) : undefined;
      } catch {
        errorCode = undefined;
      } finally {
        releaseRequest();
        await upstream.body?.cancel().catch(() => {});
      }
      // A busy backend says when to come back; pass on only a plain delay.
      const retryAfter = upstream.status === 503 ? upstream.headers.get("retry-after") : null;
      return failure(
        upstream.status >= 400 ? upstream.status : 502,
        "Could not connect to consent events stream",
        retryAfter && /^\d{1,4}$/.test(retryAfter) ? { "Retry-After": retryAfter } : {},
        errorCode,
      );
    }
    if (capabilities) {
      let payload: unknown;
      try { payload = await upstream.json(); }
      finally { releaseRequest(); }
      const enabled = payload && typeof payload === "object"
        ? (payload as { enabled?: unknown }).enabled : undefined;
      if (typeof enabled !== "boolean") return failure(502, "Could not check consent delivery");
      return Response.json({ enabled }, { headers: PRIVATE_HEADERS });
    }
    if (!upstream.body) {
      releaseRequest();
      return failure(502, "No stream body from backend");
    }
    if (upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
      releaseRequest();
      await upstream.body.cancel().catch(() => {});
      return failure(502, "Could not connect to consent events stream");
    }
    const reader = upstream.body.getReader();
    let stopped = false;
    const stop = () => {
      if (stopped) return false;
      stopped = true;
      releaseRequest();
      return true;
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (stopped) return;
          if (done) {
            stop();
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          const wasAborted = upstreamAbort.signal.aborted;
          if (!stop()) return;
          if (wasAborted) controller.close();
          else controller.error(error);
        }
      },
      async cancel() {
        stop();
        await reader.cancel().catch(() => {});
      },
    });
    return new Response(body, {
      headers: { ...PRIVATE_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no", "Content-Encoding": "none" },
    });
  } catch {
    releaseRequest();
    // Never reflect private provider errors or response bodies to the client.
    return failure(502, "Could not connect to consent events stream");
  }
}
