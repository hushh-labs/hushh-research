import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks – declared before any import that touches them
// ---------------------------------------------------------------------------

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
  CapacitorHttp: { request: vi.fn() },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ApiService.apiFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
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
  it("retries with a fresh Firebase token on 401 and adds X-Hushh-Auth-Refresh-Retry header", async () => {
    const freshToken = "fresh-firebase-token-xyz";
    (AuthService.getIdToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(freshToken);

    // First call → 401, second call (retry) → 200
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

    const response = await ApiService.apiFetch("/api/protected", {
      method: "GET",
      headers: { Authorization: "Bearer original-firebase-token" },
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

    // Final response should be the 200
    expect(response.status).toBe(200);
  });

  // 4 – Second 401 after retry dispatches auth-session-invalidated, no infinite loop
  it("dispatches auth-session-invalidated when refresh yields same token and does not retry", async () => {
    // When getIdToken returns the same token as the current bearer, the
    // service recognises the session is stale and dispatches the event
    // instead of retrying (which would loop forever).
    const staleToken = "stale-firebase-token";
    (AuthService.getIdToken as ReturnType<typeof vi.fn>).mockResolvedValue(staleToken);

    mockFetch.mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401));

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    const response = await ApiService.apiFetch("/api/protected", {
      method: "GET",
      headers: { Authorization: `Bearer ${staleToken}` },
    });

    // fetch was only called once – no retry because the token didn't change
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // The auth-session-invalidated event should have been dispatched
    const invalidatedEvents = dispatchSpy.mock.calls.filter(
      ([event]) => event instanceof CustomEvent && event.type === "auth-session-invalidated"
    );
    expect(invalidatedEvents.length).toBeGreaterThanOrEqual(1);

    // The original 401 is returned since retry bailed out
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
});
