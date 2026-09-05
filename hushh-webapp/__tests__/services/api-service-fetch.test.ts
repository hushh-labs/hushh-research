import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitorMocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  getPlatform: vi.fn(() => "web"),
  request: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks – declared before any import that touches them
// ---------------------------------------------------------------------------

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: capacitorMocks.isNativePlatform,
    getPlatform: capacitorMocks.getPlatform,
  },
  CapacitorHttp: { request: capacitorMocks.request },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhVault: {},
  HushhAuth: {},
  HushhConsent: {},
  HushhNotifications: {},
}));

vi.mock("@/lib/capacitor/kai", () => ({
  Kai: {},
  PORTFOLIO_STREAM_EVENT: "portfolio_stream",
  KAI_STREAM_EVENT: "kai_stream",
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getIdToken: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

vi.mock("@/lib/observability/client", () => ({
  toDurationBucket: () => "fast",
  trackApiRequestCompleted: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/observability/route-map", () => ({
  resolveRouteId: () => "test-route",
}));

vi.mock("@/lib/motion/api-progress-tracker", () => ({
  trackRequestStart: vi.fn(),
  trackRequestEnd: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";
import { REQUEST_TIMESTAMP_HEADER } from "@/lib/observability/request-id";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeUnsignedToken(payload: Record<string, unknown>): string {
  const payloadBase64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `header.${payloadBase64}.sig`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ApiService.apiFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    capacitorMocks.isNativePlatform.mockReturnValue(false);
    capacitorMocks.getPlatform.mockReturnValue("web");
    capacitorMocks.request.mockReset();
    vi.mocked(AuthService.getIdToken).mockReset();
    vi.mocked(AuthService.getCurrentUser).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1 – Web platform: calls fetch with relative path (no base URL)
  it("calls fetch with a relative path on web (no base URL prepended)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await ApiService.apiFetch("/api/test", {
      method: "GET",
      headers: { Authorization: "Bearer firebase-token-abc" },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    // On web the URL should be the path itself (relative), no hostname prefix
    expect(calledUrl).toBe("/api/test");
  });

  // 2 – Every request includes X-Request-Id header
  it("includes an x-request-id header in every request", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await ApiService.apiFetch("/api/ping", {
      method: "GET",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = fetchOptions.headers as Record<string, string>;
    expect(headers).toHaveProperty("x-request-id");
    expect(headers["x-request-id"]).toBeTruthy();
  });

  // 3 – 401 response triggers Firebase token refresh + retry
  it("normalizes future-dated request timestamp headers before fetch", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_716_500_000_000);

    await ApiService.apiFetch("/api/ping", {
      method: "GET",
      headers: {
        [REQUEST_TIMESTAMP_HEADER]: String(1_716_500_000_000 + 60_001),
      },
    });

    const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = fetchOptions.headers as Record<string, string>;
    expect(headers[REQUEST_TIMESTAMP_HEADER]).toBe("1716500000000");

    nowSpy.mockRestore();
  });

  it.each(["user_id", "sub"])("replays the same body when refreshed %s still identifies the same account", async (claim) => {
    const originalToken = makeUnsignedToken({ [claim]: "user-1", version: 1 });
    const freshToken = makeUnsignedToken({ [claim]: "user-1", version: 2 });
    (AuthService.getIdToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(freshToken);
    (AuthService.getCurrentUser as ReturnType<typeof vi.fn>).mockReturnValue({
      uid: "user-1",
    } as never);

    // First call → 401, second call (retry) → 200
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

    const body = JSON.stringify({ lookups: [{ lookup_id: "opaque" }] });
    const response = await ApiService.apiFetch("/api/one/connections/contact-sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${originalToken}` },
      body,
    });

    // Should have called getIdToken with force=true
    expect(AuthService.getIdToken).toHaveBeenCalledWith(true);

    // fetch was called twice: original + retry
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // The retry call should carry the fresh token and the retry header
    const [, retryOptions] = mockFetch.mock.calls[1] as [string, RequestInit];
    const retryHeaders = retryOptions.headers as Record<string, string>;
    expect(retryHeaders["Authorization"]).toBe(`Bearer ${freshToken}`);
    expect(retryHeaders["X-Hushh-Auth-Refresh-Retry"]).toBe("1");
    expect(retryOptions.method).toBe("POST");
    expect(retryOptions.body).toBe(body);

    // Final response should be the 200
    expect(response.status).toBe(200);
  });

  it.each(["account-a", "account-b"])(
    "does not replay or invalidate the replacement session when refresh resolves for %s after an account switch",
    async (refreshedAccount) => {
      const accountAToken = makeUnsignedToken({ user_id: "account-a" });
      let finishRefresh!: (token: string) => void;
      vi.mocked(AuthService.getIdToken).mockImplementationOnce(
        () => new Promise((resolve) => { finishRefresh = resolve; }),
      );
      vi.mocked(AuthService.getCurrentUser).mockReturnValue({
        uid: "account-a",
      } as never);
      const dispatchSpy = vi.spyOn(window, "dispatchEvent");
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401));

      const pendingResponse = ApiService.apiFetch(
        "/api/one/connections/contact-sync",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accountAToken}` },
          body: JSON.stringify({ lookups: [{ lookup_id: "opaque" }] }),
        },
      );

      await vi.waitFor(() => expect(AuthService.getIdToken).toHaveBeenCalledWith(true));
      vi.mocked(AuthService.getCurrentUser).mockReturnValue({ uid: "account-b" } as never);
      finishRefresh(makeUnsignedToken({ user_id: refreshedAccount, version: 2 }));
      const response = await pendingResponse;

      expect(response.status).toBe(401);
      expect(AuthService.getIdToken).toHaveBeenCalledWith(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(dispatchSpy.mock.calls.filter(([event]) =>
        event instanceof CustomEvent && event.type === "auth-session-invalidated",
      )).toHaveLength(0);
    },
  );

  // 4 – Handle unchanged token safely and keep session when user is same
  it.each([
    ["the unchanged initiating token", "unchanged"],
    ["no token", "missing"],
    ["a rejection", "rejected"],
  ])(
    "does not invalidate the replacement session when a stale refresh returns %s",
    async (_label, refreshOutcome) => {
      const accountAToken = makeUnsignedToken({ user_id: "account-a" });
      const accountA = { uid: "account-a" };
      const accountB = { uid: "account-b" };
      let finishRefresh!: (value: string | null) => void;
      let rejectRefresh!: (reason: Error) => void;
      vi.mocked(AuthService.getIdToken).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finishRefresh = resolve;
            rejectRefresh = reject;
          }),
      );
      vi.mocked(AuthService.getCurrentUser).mockReturnValue(accountA as never);
      const dispatchSpy = vi.spyOn(window, "dispatchEvent");
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401));

      const pendingResponse = ApiService.apiFetch(
        "/api/one/connections/contact-sync",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accountAToken}` },
          body: JSON.stringify({ lookups: [{ lookup_id: "opaque" }] }),
        },
      );

      await vi.waitFor(() =>
        expect(AuthService.getIdToken).toHaveBeenCalledWith(true),
      );
      vi.mocked(AuthService.getCurrentUser).mockReturnValue(accountB as never);
      if (refreshOutcome === "rejected") {
        rejectRefresh(new Error("stale refresh failed"));
      } else {
        finishRefresh(refreshOutcome === "unchanged" ? accountAToken : null);
      }
      const response = await pendingResponse;

      expect(response.status).toBe(401);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(
        dispatchSpy.mock.calls.filter(
          ([event]) =>
            event instanceof CustomEvent &&
            event.type === "auth-session-invalidated",
        ),
      ).toHaveLength(0);
    },
  );

  it("still invalidates the initiating session when its token refresh rejects", async () => {
    const accountAToken = makeUnsignedToken({ user_id: "account-a" });
    const accountA = { uid: "account-a" };
    vi.mocked(AuthService.getIdToken).mockRejectedValueOnce(
      new Error("refresh failed"),
    );
    vi.mocked(AuthService.getCurrentUser).mockReturnValue(accountA as never);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401));

    const response = await ApiService.apiFetch("/api/protected", {
      method: "GET",
      headers: { Authorization: `Bearer ${accountAToken}` },
    });

    expect(response.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(
      dispatchSpy.mock.calls.filter(
        ([event]) =>
          event instanceof CustomEvent &&
          event.type === "auth-session-invalidated",
      ),
    ).toHaveLength(1);
  });

  it("does not dispatch auth-session-invalidated when refresh yields same token for active account", async () => {
    const staleToken = makeUnsignedToken({ user_id: "user-1" });
    (AuthService.getIdToken as ReturnType<typeof vi.fn>).mockResolvedValue(staleToken);
    (AuthService.getCurrentUser as ReturnType<typeof vi.fn>).mockReturnValue({
      uid: "user-1",
    } as never);

    mockFetch.mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401));

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    const response = await ApiService.apiFetch("/api/protected", {
      method: "GET",
      headers: { Authorization: `Bearer ${staleToken}` },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const invalidatedEvents = dispatchSpy.mock.calls.filter(
      ([event]) => event instanceof CustomEvent && event.type === "auth-session-invalidated"
    );
    expect(invalidatedEvents.length).toBe(0);
    expect(response.status).toBe(401);

    dispatchSpy.mockRestore();
  });

  it("dispatches auth-session-invalidated when same bearer token belongs to a different account", async () => {
    const staleToken = makeUnsignedToken({ user_id: "user-2" });
    (AuthService.getIdToken as ReturnType<typeof vi.fn>).mockResolvedValue(staleToken);
    (AuthService.getCurrentUser as ReturnType<typeof vi.fn>).mockReturnValue({
      uid: "user-1",
    } as never);

    mockFetch.mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401));

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    const response = await ApiService.apiFetch("/api/protected", {
      method: "GET",
      headers: { Authorization: `Bearer ${staleToken}` },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const invalidatedEvents = dispatchSpy.mock.calls.filter(
      ([event]) => event instanceof CustomEvent && event.type === "auth-session-invalidated"
    );
    expect(invalidatedEvents.length).toBeGreaterThanOrEqual(1);
    expect(response.status).toBe(401);

    dispatchSpy.mockRestore();
  });

  // 5 – Successful response returns Response object
  it("returns the Response object on success", async () => {
    const payload = { message: "hello" };
    mockFetch.mockResolvedValueOnce(jsonResponse(payload, 200));

    const response = await ApiService.apiFetch("/api/data", {
      method: "GET",
      headers: { Authorization: "Bearer valid-token" },
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(payload);
  });

  it("requests a vault lock when web rejects an HCT token after validation", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ detail: "Token validation failed." }, 401)
    );
    const lockReasons: string[] = [];
    const handleLock = (event: Event) => {
      lockReasons.push(
        String((event as CustomEvent<{ reason?: string }>).detail?.reason || "")
      );
    };
    window.addEventListener("vault-lock-requested", handleLock);

    try {
      const response = await ApiService.apiFetch("/api/one/location/state", {
        headers: { Authorization: "Bearer HCT:expired-vault-owner" },
      });

      expect(response.status).toBe(401);
      expect(lockReasons).toEqual(["Token validation failed."]);
      expect(AuthService.getIdToken).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("vault-lock-requested", handleLock);
    }
  });

  it("requests the same vault lock when native rejects an HCT token", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    capacitorMocks.getPlatform.mockReturnValue("ios");
    capacitorMocks.request.mockResolvedValueOnce({
      status: 401,
      headers: { "content-type": "application/json" },
      data: { detail: "Token validation failed." },
      url: "https://uat.example/api/one/location/state",
    });
    const previousBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://uat.example";
    const lockReasons: string[] = [];
    const handleLock = (event: Event) => {
      lockReasons.push(
        String((event as CustomEvent<{ reason?: string }>).detail?.reason || "")
      );
    };
    window.addEventListener("vault-lock-requested", handleLock);

    try {
      const response = await ApiService.apiFetch("/api/one/location/state", {
        headers: { Authorization: "Bearer HCT:expired-vault-owner" },
      });

      expect(response.status).toBe(401);
      expect(lockReasons).toEqual(["Token validation failed."]);
      expect(capacitorMocks.request).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("vault-lock-requested", handleLock);
      if (previousBackendUrl === undefined) {
        delete process.env.NEXT_PUBLIC_BACKEND_URL;
      } else {
        process.env.NEXT_PUBLIC_BACKEND_URL = previousBackendUrl;
      }
    }
  });

  it("uses IPv4 loopback for local iOS simulator backend requests", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    capacitorMocks.getPlatform.mockReturnValue("ios");
    capacitorMocks.request.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { ok: true },
      url: "http://127.0.0.1:8000/health",
    });
    const previousBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = "http://localhost:8000";

    try {
      const response = await ApiService.apiFetch("/health");

      expect(response.status).toBe(200);
      expect(capacitorMocks.request).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://127.0.0.1:8000/health" }),
      );
    } finally {
      if (previousBackendUrl === undefined) {
        delete process.env.NEXT_PUBLIC_BACKEND_URL;
      } else {
        process.env.NEXT_PUBLIC_BACKEND_URL = previousBackendUrl;
      }
    }
  });

  it("sends native Plaid status requests to the configured backend URL", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    capacitorMocks.getPlatform.mockReturnValue("ios");
    capacitorMocks.request.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { ok: true },
      url: "https://api.hushh.ai/api/kai/plaid/status/user-123",
    });
    const previousBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    const previousServerBackendUrl = process.env.BACKEND_URL;
    delete process.env.BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://api.hushh.ai";

    try {
      const response = await ApiService.apiFetch("/api/kai/plaid/status/user-123", {
        headers: { Authorization: "Bearer HCT:vault-owner-token" },
      });

      expect(response.status).toBe(200);
      expect(capacitorMocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://api.hushh.ai/api/kai/plaid/status/user-123",
        })
      );
    } finally {
      if (previousBackendUrl === undefined) {
        delete process.env.NEXT_PUBLIC_BACKEND_URL;
      } else {
        process.env.NEXT_PUBLIC_BACKEND_URL = previousBackendUrl;
      }
      if (previousServerBackendUrl === undefined) {
        delete process.env.BACKEND_URL;
      } else {
        process.env.BACKEND_URL = previousServerBackendUrl;
      }
    }
  });

  it("fetches baseline market insights with Firebase auth", async () => {
    (AuthService.getIdToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce("firebase-id-token");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        generated_at: "2026-03-30T00:00:00Z",
        meta: { market_mode: "baseline" },
      })
    );

    const payload = await ApiService.getKaiMarketBaselineInsights({
      userId: "user_123",
      daysBack: 7,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("/api/kai/market/insights/baseline/user_123?days_back=7");
    expect((options.headers as Record<string, string>).Authorization).toBe(
      "Bearer firebase-id-token"
    );
    expect(payload.meta?.market_mode).toBe("baseline");
  });

  it("starts UAT phone test verification through the account proxy", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        eligible: true,
        verification_id: "uat-test-phone:abc123",
      })
    );

    const payload = await ApiService.startUatPhoneTestVerification(
      "+16505550101",
      "firebase-id-token"
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("/api/account/phone/uat-test/start");
    expect((options.headers as Record<string, string>).Authorization).toBe(
      "Bearer firebase-id-token"
    );
    expect(JSON.parse(String(options.body))).toEqual({
      phone_number: "+16505550101",
    });
    expect(payload).toEqual({
      success: true,
      eligible: true,
      verification_id: "uat-test-phone:abc123",
      reason: undefined,
    });
  });

  it("confirms UAT phone test verification without a Firebase phone token", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        user_id: "user_123",
        phone_verified: true,
        identity: {
          user_id: "user_123",
          phone_number: "+16505550101",
          phone_verified: true,
          source: "uat_test_phone_claim",
        },
      })
    );

    const payload = await ApiService.confirmUatPhoneTestVerification(
      "+16505550101",
      "000000",
      "uat-test-phone:abc123",
      "firebase-id-token"
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("/api/account/phone/uat-test/confirm");
    expect((options.headers as Record<string, string>).Authorization).toBe(
      "Bearer firebase-id-token"
    );
    expect(JSON.parse(String(options.body))).toEqual({
      phone_number: "+16505550101",
      verification_code: "000000",
      verification_id: "uat-test-phone:abc123",
    });
    expect(payload.phone_verified).toBe(true);
    expect(payload.identity?.source).toBe("uat_test_phone_claim");
  });
});
