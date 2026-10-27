// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEmailUnsubscribe } from "@/app/api/_utils/plg-email-unsubscribe";
import { isAnalyticsExemptRoute, isPublicRoute } from "@/lib/navigation/routes";
import { resolveRouteId } from "@/lib/observability/route-map";
import { redactObservabilityLog } from "@/lib/observability/log-redactor";

// Synthetic, unissued capability; every upstream call is replaced in these tests.
const token = `00000000-0000-4000-8000-000000000001.00000000-0000-4000-8000-000000000002.${"0".repeat(64)}`;
const origin = "https://one.hussh.ai";
const path = `/email/unsubscribe/${token}`;
const request = (init?: RequestInit, suffix = "") => new Request(`${origin}${path}${suffix}`, init);
const upstream = (value: unknown, status = 200) => vi.fn<typeof fetch>().mockImplementation(async () => Response.json(value, { status }));

beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("public One email unsubscribe capability", () => {
  it("shows a read-only branded confirmation with no token, session forwarding, scripts or caching", async () => {
    const fetcher = upstream({ version: 1, canUnsubscribe: true });
    const response = await handleEmailUnsubscribe(request({ headers: { Cookie: "synthetic-session", Authorization: "Bearer synthetic-owner" } }), token, fetcher);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Unsubscribe from email updates?");
    expect(html).toContain('<form method="post">');
    expect(html).toContain("/one/profile/account#email-updates");
    expect(html).not.toContain(token);
    expect(html).not.toMatch(/<script|<iframe/i);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(`https://metrics.hussh.ai/integrations/plg/email-unsubscribe/${token}`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store", headers: { Accept: "application/json" } });
    expect(fetcher.mock.calls[0][1]?.body).toBeUndefined();
    expect(Object.keys(fetcher.mock.calls[0][1]?.headers ?? {})).toEqual(["Accept"]);
  });

  it("requires a deliberate same-origin unsubscribe and returns only the typed public acknowledgment", async () => {
    const fetcher = upstream({ version: 1, unsubscribed: true });
    const response = await handleEmailUnsubscribe(request({ method: "POST", headers: {
      "Content-Type": "application/json", Origin: origin, Cookie: "synthetic-session", Authorization: "Bearer synthetic-owner",
    }, body: JSON.stringify({ action: "unsubscribe" }) }), token, fetcher);
    expect(await response.json()).toEqual({ version: 1, unsubscribed: true });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", body: '{"action":"unsubscribe"}',
      headers: { Accept: "application/json", "Content-Type": "application/json" } });
    expect(Object.keys(fetcher.mock.calls[0][1]?.headers ?? {})).toEqual(["Accept", "Content-Type"]);
  });

  it("preserves a no-login RFC8058 one-click POST and does not claim synchronous account settings changes", async () => {
    const fetcher = upstream({ version: 1, unsubscribed: true });
    const oneClick = await handleEmailUnsubscribe(request({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }), token, fetcher);
    expect(oneClick.status).toBe(200);
    expect(await oneClick.json()).toEqual({ version: 1, unsubscribed: true });
    const confirmed = await handleEmailUnsubscribe(request({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin }, body: "action=unsubscribe" }), token, fetcher);
    expect(await confirmed.text()).toContain("request has been recorded for this email link");
  });

  it.each([undefined, "null", "https://elsewhere.example.invalid"])("refuses interactive Origin %s before touching the authority", async (foreign) => {
    const fetcher = upstream({ version: 1, unsubscribed: true });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (foreign !== undefined) headers.Origin = foreign;
    expect((await handleEmailUnsubscribe(request({ method: "POST", headers, body: '{"action":"unsubscribe"}' }), token, fetcher)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["application/json", '{"action":"subscribe"}'],
    ["application/json", '{"action":"unsubscribe","frequency":"daily"}'],
    ["application/x-www-form-urlencoded", "List-Unsubscribe=One-Click&action=unsubscribe"],
    ["text/plain", "unsubscribe"],
  ])("rejects an unsupported action/body (%s) without a write", async (type, body) => {
    const fetcher = upstream({ version: 1, unsubscribed: true });
    const response = await handleEmailUnsubscribe(request({ method: "POST", headers: { "Content-Type": type, Origin: origin }, body }), token, fetcher);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds actual chunked input, not only the declared content length", async () => {
    const fetcher = upstream({ version: 1, unsubscribed: true });
    const response = await handleEmailUnsubscribe(request({ method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: " ".repeat(257) }), token, fetcher);
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["uat", "development", ""])("never falls back from %s to the production authority", async (environment) => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", environment); vi.stubEnv("NODE_ENV", "production");
    const fetcher = upstream({ version: 1, canUnsubscribe: true });
    expect((await handleEmailUnsubscribe(request(), token, fetcher)).status).toBe(503);
    expect((await handleEmailUnsubscribe(new Request(`https://0.0.0.0:8080${path}`, { headers: { Host: "one.hussh.ai" } }), token, fetcher)).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed capabilities and arbitrary upstream/query parameters without a network call", async () => {
    const fetcher = upstream({ version: 1, canUnsubscribe: true });
    expect((await handleEmailUnsubscribe(request(), "../not-a-capability", fetcher)).status).toBe(404);
    expect((await handleEmailUnsubscribe(request(undefined, "?upstream=https://elsewhere.example.invalid"), token, fetcher)).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["https://uat.one.hussh.ai", "https://unqualified.example.run.app", "http://one.hussh.ai"])("rejects host %s even in a production-built process", async (host) => {
    const fetcher = upstream({ version: 1, canUnsubscribe: true });
    expect((await handleEmailUnsubscribe(new Request(`${host}${path}`), token, fetcher)).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts the actual standalone HTTPS bind using its canonical public Host for confirmation and interactive Origin checks", async () => {
    const fetcher = upstream({ version: 1, canUnsubscribe: true });
    const internal = `https://0.0.0.0:8080${path}`;
    expect((await handleEmailUnsubscribe(new Request(internal, { headers: { Host: "one.hussh.ai" } }), token, fetcher)).status).toBe(200);
    fetcher.mockImplementation(async () => Response.json({ version: 1, unsubscribed: true }));
    const response = await handleEmailUnsubscribe(new Request(internal, { method: "POST", headers: {
      Host: "one.hussh.ai", Origin: origin, "Content-Type": "application/json",
    }, body: '{"action":"unsubscribe"}' }), token, fetcher);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, unsubscribed: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(Object.keys(fetcher.mock.calls[1][1]?.headers ?? {})).toEqual(["Accept", "Content-Type"]);
  });

  it.each<[string, Record<string, string>]>([
    ["https://0.0.0.0:8080", { Host: "uat.one.hussh.ai", "X-Forwarded-Host": "one.hussh.ai" }],
    ["https://0.0.0.0:8080", { Host: "unqualified.example.run.app", "X-Forwarded-Host": "one.hussh.ai" }],
    ["https://0.0.0.0:8080", { "X-Forwarded-Host": "one.hussh.ai" }],
    ["http://0.0.0.0:8080", { Host: "one.hussh.ai", "X-Forwarded-Proto": "https" }],
    ["https://localhost:8080", { Host: "one.hussh.ai" }],
    ["https://unqualified.example.run.app", { Host: "one.hussh.ai" }],
    [origin, { Host: "elsewhere.example.invalid" }],
  ])("rejects unqualified or conflicting proxy host metadata at %s", async (url, headers) => {
    const fetcher = upstream({ version: 1, canUnsubscribe: true });
    expect((await handleEmailUnsubscribe(new Request(`${url}${path}`, { headers }), token, fetcher)).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an internal bind Origin on a public-host interactive POST", async () => {
    const fetcher = upstream({ version: 1, unsubscribed: true });
    const response = await handleEmailUnsubscribe(new Request(`https://0.0.0.0:8080${path}`, { method: "POST", headers: {
      Host: "one.hussh.ai", Origin: "https://0.0.0.0:8080", "Content-Type": "application/json",
    }, body: '{"action":"unsubscribe"}' }), token, fetcher);
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps legacy-generation recovery in the authenticated account and never echoes provider information", async () => {
    const legacy = await handleEmailUnsubscribe(request(), token, upstream({ detail: "unavailable" }, 409));
    expect(legacy.status).toBe(409);
    expect(await legacy.text()).toContain("/one/profile/account#email-updates");
    for (const value of [{ version: 1, canUnsubscribe: true, email: "synthetic@example.invalid" }, { version: 2, canUnsubscribe: true }]) {
      const response = await handleEmailUnsubscribe(request(), token, upstream(value));
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("synthetic@example.invalid");
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(`Synthetic upstream error at ${origin}${path}`));
    const failed = await handleEmailUnsubscribe(request(), token, fetcher);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain(token);
    expect(log).not.toHaveBeenCalled();
  });

  it("exempts both public and direct HTTP handler paths from analytics and redacts the whole capability", () => {
    for (const prefix of ["/email/unsubscribe", "/api/plg-email/unsubscribe"]) {
      const route = `${prefix}/${token}`;
      expect(isPublicRoute(route)).toBe(true);
      expect(isAnalyticsExemptRoute(route)).toBe(true);
      expect(resolveRouteId(route)).toBe("email_unsubscribe");
      const redacted = redactObservabilityLog(`GET ${origin}${route}`);
      expect(redacted).not.toContain(token);
      expect(redacted).not.toContain("00000000-0000");
    }
    expect(isPublicRoute("/email/subscribe")).toBe(false);
    expect(isAnalyticsExemptRoute("/email/unsubscribe-other")).toBe(false);
  });

  it("exposes the public HTTP route only in the web rewrite map", async () => {
    vi.stubEnv("CAPACITOR_BUILD", "false"); vi.resetModules();
    const web = (await import("../../next.config")).default;
    expect(await web.rewrites?.()).toContainEqual({ source: "/email/unsubscribe/:token", destination: "/api/plg-email/unsubscribe/:token" });
    vi.stubEnv("CAPACITOR_BUILD", "true"); vi.resetModules();
    const native = (await import("../../next.config")).default;
    expect(await native.rewrites?.()).toEqual([]);
  });
});
