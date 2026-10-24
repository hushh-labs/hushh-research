/** Keep Firebase recovery and private-pod authority distinct on 401 responses. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  CapacitorHttp: { request: vi.fn() },
}));
vi.mock("@/lib/capacitor", () => ({ HushhVault: {}, HushhAuth: {}, HushhConsent: {}, HushhNotifications: {} }));
vi.mock("@/lib/capacitor/kai", () => ({ Kai: {}, PORTFOLIO_STREAM_EVENT: "portfolio_stream", KAI_STREAM_EVENT: "kai_stream" }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getIdToken: vi.fn(), getCurrentUser: vi.fn() } }));
vi.mock("@/lib/observability/client", () => ({ toDurationBucket: () => "fast", trackApiRequestCompleted: vi.fn(), trackEvent: vi.fn() }));
vi.mock("@/lib/observability/route-map", () => ({ resolveRouteId: () => "test-route" }));
vi.mock("@/lib/motion/api-progress-tracker", () => ({ trackRequestStart: vi.fn(), trackRequestEnd: vi.fn() }));
import { ApiService } from "@/lib/services/api-service";
import { publishValidatedAuthSessionOwner, publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { AUTH_SESSION_INVALIDATED_EVENT } from "@/lib/auth/session-invalidation";
import { AuthService } from "@/lib/services/auth-service";
const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function makeUnsignedToken(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `header.${encoded}.sig`;
}
beforeEach(() => { vi.clearAllMocks(); mockFetch.mockReset(); publishValidatedAuthSessionOwner(null); });
afterEach(() => vi.restoreAllMocks());
describe("ApiService authentication recovery", () => {
  it("scopes a Firebase terminal response to the admitted replacement owner", async () => {
    const ownerId = "acct_" + "3".repeat(32);
    publishValidatedAuthSessionPrincipal({ firebaseUid: "user-1", ownerId, accountGeneration: 1 });
    const token = makeUnsignedToken({ sub: "user-1" });
    vi.mocked(AuthService.getCurrentUser).mockReturnValue({ uid: "user-1" } as never);
    mockFetch.mockResolvedValueOnce(jsonResponse({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, 401));
    const events = vi.spyOn(window, "dispatchEvent");
    await ApiService.apiFetch("/api/account/session-status", { headers: { Authorization: `Bearer ${token}` } });
    const invalidations = events.mock.calls.map(([event]) => event).filter(event => event.type === AUTH_SESSION_INVALIDATED_EVENT);
    expect(invalidations).toHaveLength(1);
    expect((invalidations[0] as CustomEvent).detail).toMatchObject({ userId: ownerId, code: "account_not_found" });
    expect(AuthService.getIdToken).not.toHaveBeenCalled();
  });

  it("does not invalidate or replay a request after the same UID changes application generation", async () => {
    publishValidatedAuthSessionPrincipal({ firebaseUid: "user-1", ownerId: "user-1", accountGeneration: 0 });
    vi.mocked(AuthService.getCurrentUser).mockReturnValue({ uid: "user-1" } as never);
    let finish!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const events = vi.spyOn(window, "dispatchEvent");
    const pending = ApiService.apiFetch("/api/account/session-status", {
      headers: { Authorization: `Bearer ${makeUnsignedToken({ sub: "user-1" })}` },
    });
    publishValidatedAuthSessionPrincipal({ firebaseUid: "user-1", ownerId: "acct_" + "4".repeat(32), accountGeneration: 1 });
    finish(jsonResponse({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, 401));
    await pending;
    expect(events.mock.calls.filter(([event]) => event.type === AUTH_SESSION_INVALIDATED_EVENT)).toHaveLength(0);
    expect(AuthService.getIdToken).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("refuses replay when account generation changes during Firebase refresh", async () => {
    publishValidatedAuthSessionPrincipal({ firebaseUid: "user-1", ownerId: "acct_" + "c".repeat(32), accountGeneration: 1 });
    const sdkUser = { uid: "user-1" };
    vi.mocked(AuthService.getCurrentUser).mockReturnValue(sdkUser as never);
    let finish!: (token: string) => void;
    vi.mocked(AuthService.getIdToken).mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401));
    const events = vi.spyOn(window, "dispatchEvent");
    const pending = ApiService.apiFetch("/api/one/connections/contact-sync", {
      method: "POST", body: JSON.stringify({ lookups: [] }),
      headers: { Authorization: `Bearer ${makeUnsignedToken({ sub: "user-1", version: 1 })}` },
    });
    await vi.waitFor(() => expect(AuthService.getIdToken).toHaveBeenCalledWith(true));
    publishValidatedAuthSessionPrincipal({ firebaseUid: "user-1", ownerId: "acct_" + "d".repeat(32), accountGeneration: 2 });
    finish(makeUnsignedToken({ sub: "user-1", version: 2 }));
    expect((await pending).status).toBe(401);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(events.mock.calls.filter(([event]) => event.type === AUTH_SESSION_INVALIDATED_EVENT)).toHaveLength(0);
  });

  it("forwards admitted application ownership through the real pod API wrapper", async () => {
    const ownerId = "acct_" + "e".repeat(32);
    publishValidatedAuthSessionPrincipal({ firebaseUid: "user-1", ownerId, accountGeneration: 1 });
    vi.mocked(AuthService.getCurrentUser).mockReturnValue({ uid: "user-1" } as never);
    const access = await import("@/lib/services/pod-app-access");
    const forward = vi.spyOn(access, "ownerPodRequest").mockResolvedValueOnce(new Response("accepted"));
    const init = { method: "GET" };
    await ApiService.ownerPodRequest("files/list", init);
    expect(forward).toHaveBeenCalledWith("files/list", init, expect.any(Object), undefined, ownerId, expect.any(Number));
  });

  it("does not wake a pod when owner authority retires during token retrieval", async () => {
    let finish!: (token: string) => void;
    const token = new Promise<string>(resolve => { finish = resolve; });
    vi.mocked(AuthService.getIdToken).mockReturnValueOnce(token);
    let current = true;
    const pending = ApiService.wakePod({ isEffectCurrent: () => current });
    current = false;
    finish("retired-id-token");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("preserves dated prices and cached-history metadata through the authenticated transport", async () => {
    vi.mocked(AuthService.getIdToken).mockResolvedValueOnce("firebase-id-token");
    mockFetch.mockResolvedValueOnce(jsonResponse({ points: [{ t: 1792000000, p: 230 }], stale: true, retrieved_at: "2026-10-20T20:00:00Z" }));
    const history = await ApiService.getKaiStockPriceHistory("owner", "BRK-B");
    expect(history).toEqual({ points: [{ date: new Date(1792000000 * 1000).toISOString(), value: 230 }], stale: true, retrievedAt: "2026-10-20T20:00:00Z" });
    expect(String(mockFetch.mock.calls[0][0])).toContain("/api/kai/market/history/owner?symbol=BRK-B");
    expect(new Headers(mockFetch.mock.calls[0][1].headers).get("Authorization")).toBe("Bearer firebase-id-token");
    vi.mocked(AuthService.getIdToken).mockResolvedValueOnce(null);
    await expect(ApiService.getKaiStockPriceHistory("owner", "AAPL")).rejects.toThrow("Missing authentication");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["user_id", "sub"])(
    "replays the same body when refreshed %s still identifies the same account",
    async (claim) => {
      publishValidatedAuthSessionPrincipal({ firebaseUid: "user-1", ownerId: "acct_" + "6".repeat(32), accountGeneration: 1 });
      const originalToken = makeUnsignedToken({
        [claim]: "user-1",
        version: 1,
      });
      const freshToken = makeUnsignedToken({ [claim]: "user-1", version: 2 });
      (
        AuthService.getIdToken as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(freshToken);
      (AuthService.getCurrentUser as ReturnType<typeof vi.fn>).mockReturnValue({
        uid: "user-1",
      } as never);

      // First call → 401, second call (retry) → 200
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401))
        .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

      const body = JSON.stringify({ lookups: [{ lookup_id: "opaque" }] });
      const response = await ApiService.apiFetch(
        "/api/one/connections/contact-sync",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${originalToken}` },
          body,
        },
      );

      // Should have called getIdToken with force=true
      expect(AuthService.getIdToken).toHaveBeenCalledWith(true);

      // fetch was called twice: original + retry
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // The retry call should carry the fresh token and the retry header
      const [, retryOptions] = mockFetch.mock.calls[1] as [string, RequestInit];
      const retryHeaders = new Headers(retryOptions.headers);
      expect(retryHeaders.get("Authorization")).toBe(`Bearer ${freshToken}`);
      expect(retryHeaders.get("X-Hushh-Auth-Refresh-Retry")).toBe("1");
      expect(retryOptions.method).toBe("POST");
      expect(retryOptions.body).toBe(body);

      // Final response should be the 200
      expect(response.status).toBe(200);
    },
  );

  it.each(["MCP_STRIPE_OAUTH_REQUIRED", "AUTH_ACCOUNT_NOT_FOUND"])(
    "preserves pod authority and its %s refusal without Firebase recovery",
    async (code) => {
      const podToken = makeUnsignedToken({ user_id: "user-1", role: "app" })
        .replace(/^header\./, "pst1.");
      vi.mocked(AuthService.getCurrentUser).mockReturnValue({ uid: "user-1" } as never);
      vi.mocked(AuthService.getIdToken).mockResolvedValue(makeUnsignedToken({ user_id: "user-1", version: 2 }));
      const refusal = { detail: { code } };
      mockFetch.mockResolvedValueOnce(jsonResponse(refusal, 401))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const events = vi.spyOn(window, "dispatchEvent");

      const response = await ApiService.apiFetch("https://owner-pod.example/api/one/pod/agent-chat/connectors/custom_fixture/mcp/catalog", {
        method: "POST", credentials: "omit", headers: { Authorization: `Bearer ${podToken}` },
        body: JSON.stringify({ connectorConfiguration: { endpoint: "https://mcp.stripe.com" } }),
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(refusal);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(new Headers(mockFetch.mock.calls[0][1]?.headers).get("Authorization")).toBe(`Bearer ${podToken}`);
      expect(AuthService.getIdToken).not.toHaveBeenCalled();
      expect(events.mock.calls.filter(([event]) => event.type === "auth-session-invalidated")).toHaveLength(0);
    },
  );

});
