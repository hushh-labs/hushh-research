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
import { AuthService } from "@/lib/services/auth-service";
const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function makeUnsignedToken(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `header.${encoded}.sig`;
}
beforeEach(() => { vi.clearAllMocks(); mockFetch.mockReset(); });
afterEach(() => vi.restoreAllMocks());
describe("ApiService authentication recovery", () => {
  it.each(["user_id", "sub"])(
    "replays the same body when refreshed %s still identifies the same account",
    async (claim) => {
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
