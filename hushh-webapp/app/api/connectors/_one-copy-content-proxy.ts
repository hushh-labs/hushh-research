import type { NextRequest } from "next/server";
import { withRequestIdJson } from "@/app/api/_utils/request-id";

const CONTENT = /^google_drive\/sharing\/requests\/[0-9a-f-]{36}\/one-copy\/files\/[0-9a-f-]{36}\/content$/i;
export function isOneCopyContentRequest(method: string, path: string): boolean {
  return method === "GET" && CONTENT.test(path);
}
/** Preserve original bytes through the existing authenticated connector proxy. */
export async function proxyOneCopyContent(request: NextRequest, targetUrl: string, headers: Headers, requestId: string): Promise<Response> {
  const privateHeaders = {
    "Cache-Control": "private, no-store, no-transform", Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId,
    "Content-Security-Policy": "sandbox; default-src 'none'",
  };
  const error = (status: number) => withRequestIdJson(requestId,
    { detail: { code: "one_copy_unavailable" } }, { status, headers: privateHeaders });
  if (!request.headers.get("authorization")) return error(401);
  const disposition = request.nextUrl.searchParams.get("disposition");
  if (disposition !== "preview" && disposition !== "download") return error(400);
  try {
    const upstream = await fetch(targetUrl, {
      method: "GET", headers, cache: "no-store", redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
    });
    if (!upstream.ok) return error(upstream.status);
    const mime = upstream.headers.get("content-type")?.split(";", 1)[0] || "application/octet-stream";
    if (disposition === "preview" && mime !== "application/pdf") return error(415);
    const attachment = upstream.headers.get("content-disposition");
    return new Response(upstream.body, { status: upstream.status, headers: {
      ...privateHeaders, "Content-Type": mime,
      // Even a direct navigation to an active original must never execute it.
      "Content-Disposition": attachment?.startsWith("attachment;") ? attachment : "attachment; filename=document",
    } });
  } catch { return error(request.signal.aborted ? 499 : 502); }
}
