import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

import { proxyConsentStream } from "@/app/api/_utils/consent-stream-proxy";

/**
 * The backend deliberately answers the legacy consent SSE stream with 410
 * CONSENT_SSE_DISABLED (FCM is primary; see notification-provider.tsx's own
 * backoff test). The client only stops reconnecting when it can read that
 * exact code back off this proxy's response. A `response.json()` -> `{error}`
 * reshape here silently defeated that check in production: every browser tab
 * repeated the full 3s/6s/12s/24s/48s backoff on every page load because the
 * client could never distinguish "permanently disabled" from "transiently
 * unavailable". This file protects the proxy's half of that contract; the
 * client's reaction to a correctly-shaped body is covered separately in
 * consent-notification-provider-sse-backoff.test.tsx.
 */
function request(userId: string) {
  return new Request(`http://localhost:3000/api/consent/events/${userId}`, {
    headers: { Authorization: "Bearer firebase-token" },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("proxyConsentStream 410 handling", () => {
  it("forwards CONSENT_SSE_DISABLED so the client can give up permanently", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            error_code: "CONSENT_SSE_DISABLED",
            message: "Consent SSE is disabled. Use FCM notifications.",
          },
        }),
        { status: 410, headers: { "Content-Type": "application/json" } },
      ),
    );

    const response = await proxyConsentStream(request("owner-1"), "owner-1", "events");
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body.detail).toEqual({ error_code: "CONSENT_SSE_DISABLED" });
  });

  it("forwards a different 410 code so an expired stream is not mistaken for a permanent refusal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: { error_code: "STREAM_EXPIRED" } }), {
        status: 410,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await proxyConsentStream(request("owner-1"), "owner-1", "events");
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body.detail).toEqual({ error_code: "STREAM_EXPIRED" });
  });

  it("omits detail entirely when the upstream 410 body carries no error_code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not json", { status: 410 }),
    );

    const response = await proxyConsentStream(request("owner-1"), "owner-1", "events");
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body.detail).toBeUndefined();
  });

  it("never reflects the upstream message, only the enum code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            error_code: "CONSENT_SSE_DISABLED",
            message: "private-internal-diagnostic-detail",
          },
        }),
        { status: 410, headers: { "Content-Type": "application/json" } },
      ),
    );

    const response = await proxyConsentStream(request("owner-1"), "owner-1", "events");
    const text = await response.text();

    expect(text).not.toContain("private-internal-diagnostic-detail");
  });

  it("still cancels and masks a non-410 upstream failure as before", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "30" }),
      body: { cancel },
    } as unknown as Response);

    const response = await proxyConsentStream(request("owner-1"), "owner-1", "events");
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(body).toEqual({ error: "Could not connect to consent events stream" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
