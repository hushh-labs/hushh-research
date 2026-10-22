import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "https://backend.example.test",
}));

import { proxyConsentStream } from "@/app/api/_utils/consent-stream-proxy";

/**
 * The request storm in consent-notification-provider-sse-backoff.test.tsx
 * traces to the client never recognizing a disabled-lane 410: this proxy sat
 * between it and the backend, discarding the backend's `detail.error_code`
 * and replacing it with a generic message on every non-2xx response. The
 * client then treated every CONSENT_SSE_DISABLED 410 as a transient failure
 * and retried it five times before giving up, every time.
 */
describe("proxyConsentStream forwards the upstream error discriminator", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function request() {
    return new Request("https://app.example.test/api/consent/events/user-1", {
      headers: { authorization: "Bearer test-token" },
    });
  }

  it("forwards authenticated discovery and returns only the availability flag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ enabled: false, private_detail: "must not escape" }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await proxyConsentStream(
      new Request("https://app.example.test/api/consent/events/user-1?capabilities=1&ignored=private", {
        headers: { authorization: "Bearer test-token" },
      }), "user-1", "events",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://backend.example.test/api/consent/events/user-1?capabilities=1",
      expect.objectContaining({ headers: expect.objectContaining({
        Authorization: "Bearer test-token",
        "X-Hussh-Stream-Via": "next-proxy",
      }) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects malformed discovery flags before forwarding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await proxyConsentStream(new Request(
      "https://app.example.test/api/consent/events/user-1?capabilities=anything",
      { headers: { authorization: "Bearer test-token" } },
    ), "user-1", "events");
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an invalid upstream discovery response without reflecting its contents", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ enabled: "false", private_detail: "private" })));
    const response = await proxyConsentStream(new Request(
      "https://app.example.test/api/consent/events/user-1?capabilities=1",
      { headers: { authorization: "Bearer test-token" } },
    ), "user-1", "events");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private_detail");
  });

  it("preserves detail.error_code from a disabled-lane 410 instead of discarding it", async () => {
    let upstreamSignal!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
        upstreamSignal = options.signal!;
        const upstream = new Response(
          JSON.stringify({
            detail: {
              error_code: "CONSENT_SSE_DISABLED",
              message: "Consent SSE is disabled. Use FCM notifications.",
            },
          }),
          { status: 410 },
        );
        const read = upstream.text.bind(upstream);
        vi.spyOn(upstream, "text").mockImplementation(() => {
          if (upstreamSignal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
          return read();
        });
        return upstream;
      }),
    );

    const response = await proxyConsentStream(request(), "user-1", "events");
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.detail?.error_code).toBe("CONSENT_SSE_DISABLED");
    expect(upstreamSignal.aborted).toBe(true);
  });

  it("preserves a different 410 code so an expired stream isn't mistaken for a permanent refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: { error_code: "STREAM_EXPIRED" } }), {
          status: 410,
        }),
      ),
    );

    const response = await proxyConsentStream(request(), "user-1", "events");
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.detail?.error_code).toBe("STREAM_EXPIRED");
  });

  it("never reflects the upstream message, only the enum code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: {
              error_code: "CONSENT_SSE_DISABLED",
              message: "private-internal-diagnostic-detail",
            },
          }),
          { status: 410 },
        ),
      ),
    );

    const response = await proxyConsentStream(request(), "user-1", "events");
    const text = await response.text();
    expect(text).not.toContain("private-internal-diagnostic-detail");
  });

  it("omits detail when the upstream error carries no recognizable code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("service unavailable", { status: 503 }),
      ),
    );

    const response = await proxyConsentStream(request(), "user-1", "events");
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.detail).toBeUndefined();
  });

  it("degrades without throwing when the upstream error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>gateway error</html>", { status: 502 }),
      ),
    );

    const response = await proxyConsentStream(request(), "user-1", "events");
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.detail).toBeUndefined();
  });
});
