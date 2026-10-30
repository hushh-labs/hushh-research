// Thin pass-through for the enterprise SSO endpoints. The backend owns every
// decision; this only forwards, preserves the status and JSON body (refusals
// carry a stable code), and keeps responses out of shared caches.

import { NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

const REQUEST_TIMEOUT_MS = 30000;
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function proxyEnterpriseSso(
  path: string,
  init: { method: "GET" | "POST"; search?: string; body?: string; forwardedFor?: string | null },
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${getPythonApiUrl()}${path}${init.search ?? ""}`, {
      method: init.method,
      // The backend rate-limits per visitor, and only this proxy sees who the visitor is.
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.forwardedFor ? { "X-Forwarded-For": init.forwardedFor } : {}),
      },
      body: init.body,
      cache: "no-store",
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    return NextResponse.json(
      data ?? { detail: { code: "sso_unavailable", message: "Single sign-on is temporarily unavailable." } },
      { status: data ? response.status : 502, headers: NO_STORE_HEADERS },
    );
  } catch {
    return NextResponse.json(
      { detail: { code: "sso_unavailable", message: "Single sign-on is temporarily unavailable." } },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  } finally {
    clearTimeout(timeout);
  }
}
