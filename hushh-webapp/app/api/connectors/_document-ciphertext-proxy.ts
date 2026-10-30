import { NextRequest } from "next/server";

import { withRequestIdJson } from "@/app/api/_utils/request-id";

const MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024 + 128 * 1024;
const RAW_ROUTE = /^google_drive\/sharing\/requests\/[0-9a-f-]{36}\/delivery\/(uploads|artifacts)\/[0-9a-f-]{36}$/;

export function isDocumentCiphertextRequest(method: string, path: string): boolean {
  const match = RAW_ROUTE.exec(path);
  return Boolean(match && ((method === "PUT" && match[1] === "uploads") ||
    (method === "GET" && match[1] === "artifacts")));
}

async function boundedBytes(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CIPHERTEXT_BYTES) throw new RangeError("ciphertext limit");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function proxyDocumentCiphertext(
  request: NextRequest,
  targetUrl: string,
  headers: Headers,
  requestId: string,
): Promise<Response> {
  const privateHeaders = {
    "Cache-Control": "private, no-store, no-transform",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
  };
  const error = (status: number) => withRequestIdJson(requestId,
    { detail: { code: "document_ciphertext_unavailable" } }, { status, headers: privateHeaders });
  if (!request.headers.get("authorization")) return error(401);
  if (request.method === "PUT" && request.headers.get("content-type")?.split(";")[0] !== "application/octet-stream") {
    return error(415);
  }
  try {
    headers.set("Accept", request.method === "GET" ? "application/octet-stream" : "application/json");
    let body: Uint8Array | undefined;
    if (request.method === "PUT") {
      body = await boundedBytes(request.body);
      headers.set("Content-Type", "application/octet-stream");
    }
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: body as BodyInit | undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
    });
    if (!upstream.ok) {
      // Preserve only canonical error codes; provider payloads/locators never
      // cross this narrowly scoped binary boundary.
      const payload = await upstream.json().catch(() => null);
      return withRequestIdJson(requestId,
        { detail: { code: typeof payload?.detail?.code === "string" ? payload.detail.code : "document_ciphertext_unavailable" } },
        { status: upstream.status, headers: privateHeaders });
    }
    if (request.method === "PUT") {
      return withRequestIdJson(requestId, await upstream.json(), { status: upstream.status, headers: privateHeaders });
    }
    if (upstream.headers.get("content-type")?.split(";")[0] !== "application/octet-stream") return error(502);
    const ciphertext = await boundedBytes(upstream.body);
    return new Response(ciphertext as BodyInit, {
      status: upstream.status,
      headers: { ...privateHeaders, "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=encrypted-document.bin" },
    });
  } catch (caught) {
    return error(caught instanceof RangeError ? 413 : request.signal.aborted ? 499 : 502);
  }
}
