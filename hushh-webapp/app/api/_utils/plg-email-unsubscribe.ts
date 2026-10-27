/** Public, bearer-bound opt-out facade. Never forwards an account session. */
const ONE_ORIGINS = new Set([
  "https://one.hushh.ai", "https://one.hussh.ai", "https://one.hussh.si",
]);
const MATRIX_ORIGIN = "https://metrics.hussh.ai";
const CAPABILITY = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?\.[a-f0-9]{64}$/;
const HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
type View = "confirm" | "received" | "legacy" | "invalid" | "unavailable";

function confirmation(view: View, status: number): Response {
  const copy = {
    confirm: ["Unsubscribe from email updates?", "You can stop One tips and product updates using this email link."],
    received: ["Request recorded", "Your unsubscribe request has been recorded for this email link. You can review your current email preferences in your account."],
    legacy: ["Manage email updates in your account", "This older email link needs an account check. Sign in to review or turn off your current email updates."],
    invalid: ["This email link is unavailable", "Open the link from your email again, or manage email updates in your account."],
    unavailable: ["Please try again shortly", "We could not confirm this email link right now. You can also manage email updates in your account."],
  }[view];
  // No token, identity, server error or upstream response is interpolated here.
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Email updates · One</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f5f7fa;color:#142033;font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:480px;margin:8vh auto;padding:24px}header{display:flex;align-items:center;gap:10px;margin-bottom:28px;font-weight:700;font-size:24px}header img{width:34px;height:34px}article{background:white;border:1px solid #e2e8f0;border-radius:18px;padding:28px}h1{font-size:25px;line-height:1.3;margin:0 0 16px;letter-spacing:-.5px}p{color:#536175;margin:0 0 22px}button{width:100%;border:0;border-radius:10px;padding:14px 18px;background:#1d4ed8;color:white;font:600 16px/1.5 system-ui;cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #93c5fd;outline-offset:4px}a{color:#1d4ed8}footer{font-size:13px;margin:22px 0;color:#64748b}footer a{color:#536175}small{display:block;margin-top:18px;color:#64748b;font-size:12px}
  </style></head><body><main><header><img src="/brand/hushh-mark.png" alt=""><span>hussh</span></header><article><h1>${copy[0]}</h1><p>${copy[1]}</p>${view === "confirm" ? '<form method="post"><input type="hidden" name="action" value="unsubscribe"><button type="submit">Unsubscribe</button></form>' : ''}<small>One, your private agent.</small></article><footer><a href="/one/profile/account#email-updates">Manage email preferences</a><br><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of use</a></footer></main></body></html>`, {
    status, headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

async function boundedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) throw new Error("empty_body");
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  const deadline = Date.now() + 5000;
  let bytes = 0, complete = false;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("body_timeout");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([
          reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("body_timeout")), remaining); }),
        ]);
      } finally { clearTimeout(timer); }
      if (result.done) { complete = true; break; }
      bytes += result.value.byteLength;
      if (bytes > limit) throw new Error("body_limit");
      chunks.push(result.value);
    }
    const joined = new Uint8Array(bytes);
    let position = 0;
    for (const chunk of chunks) { joined.set(chunk, position); position += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function exact(value: unknown, flag: "canUnsubscribe" | "unsubscribed"): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 2 && (value as Record<string, unknown>).version === 1 &&
    (value as Record<string, unknown>)[flag] === true;
}

function publicOrigin(request: Request, incoming: URL): string | null {
  const host = request.headers.get("host")?.toLowerCase();
  if (ONE_ORIGINS.has(incoming.origin))
    return !host || host === incoming.host ? incoming.origin : null;
  // The deployed standalone server binds 0.0.0.0:8080. Next builds its
  // request URL from that bind address; Cloud Run retains the public Host.
  // Accept only that exact HTTPS bind and a canonical Host, never a forwarded
  // host override or a direct run.app/UAT request.
  const origin = host ? `https://${host}` : "";
  return incoming.origin === "https://0.0.0.0:8080" && ONE_ORIGINS.has(origin) ? origin : null;
}

/** Only production has a qualified Matrix authority. Other lanes fail closed. */
export async function handleEmailUnsubscribe(request: Request, token: string, fetcher: typeof fetch = fetch): Promise<Response> {
  const incoming = new URL(request.url);
  if (!CAPABILITY.test(token) || incoming.search) return confirmation("invalid", 404);
  const origin = publicOrigin(request, incoming);
  if (process.env.NEXT_PUBLIC_APP_ENV !== "production" || !origin)
    return confirmation("unavailable", 503);
  if (!["GET", "POST"].includes(request.method)) return new Response(null, { status: 405, headers: { ...HEADERS, Allow: "GET, POST" } });

  let oneClick = false, jsonResponse = false;
  if (request.method === "POST") {
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 256)) return confirmation("invalid", 413);
    try {
      const text = await boundedText(request.body, 256);
      if (type === "application/json") {
        const input = JSON.parse(text);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || input.action !== "unsubscribe")
          return confirmation("invalid", 400);
        jsonResponse = true;
      } else if (type === "application/x-www-form-urlencoded") {
        const fields = [...new URLSearchParams(text).entries()];
        if (fields.length !== 1) return confirmation("invalid", 400);
        oneClick = fields[0][0] === "List-Unsubscribe" && fields[0][1] === "One-Click";
        if (!oneClick && !(fields[0][0] === "action" && fields[0][1] === "unsubscribe")) return confirmation("invalid", 400);
        jsonResponse = oneClick;
      } else return confirmation("invalid", 415);
    } catch { return confirmation("invalid", 400); }
    const suppliedOrigin = request.headers.get("origin");
    if ((!oneClick || suppliedOrigin !== null) && suppliedOrigin !== origin) return confirmation("invalid", 403);
  }

  try {
    const response = await fetcher(`${MATRIX_ORIGIN}/integrations/plg/email-unsubscribe/${token}`, {
      method: request.method, redirect: "error", cache: "no-store", credentials: "omit",
      referrerPolicy: "no-referrer", signal: AbortSignal.timeout(8000),
      headers: request.method === "POST" ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
      ...(request.method === "POST" ? { body: JSON.stringify({ action: "unsubscribe" }) } : {}),
    });
    if (response.status === 409) return confirmation("legacy", 409);
    if ([400, 404, 410].includes(response.status)) return confirmation("invalid", 404);
    if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "application/json") return confirmation("unavailable", 503);
    const value: unknown = JSON.parse(await boundedText(response.body, 1024));
    if (!exact(value, request.method === "GET" ? "canUnsubscribe" : "unsubscribed")) return confirmation("unavailable", 503);
    if (request.method === "GET") return confirmation("confirm", 200);
    return jsonResponse ? Response.json({ version: 1, unsubscribed: true }, { headers: HEADERS }) : confirmation("received", 200);
  } catch {
    // Capability URLs, upstream bodies and errors are intentionally never logged.
    return confirmation("unavailable", 503);
  }
}
