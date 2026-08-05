/**
 * Wallet Profile contract §7: the public scanned page emits no analytics.
 *
 * ObservabilityRouteObserver already bails on isAnalyticsExemptRoute, but that
 * only covers the page view. Every card resolve still runs through
 * ApiService.apiFetch -> recordApiRequestMetric -> trackApiRequestCompleted,
 * which would put the scanned card's routeId into the dataLayer for a visitor
 * who is a stranger holding someone else's printed QR.
 *
 * These lock in that the exemption covers the whole request surface of the
 * page, not just its page view.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitorMocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  getPlatform: vi.fn(() => "web"),
  request: vi.fn(),
}));

const observabilityMocks = vi.hoisted(() => ({
  trackApiRequestCompleted: vi.fn(),
}));

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
  AuthService: { getIdToken: vi.fn(), getCurrentUser: vi.fn() },
}));

vi.mock("@/lib/observability/client", () => ({
  toDurationBucket: () => "fast",
  trackApiRequestCompleted: observabilityMocks.trackApiRequestCompleted,
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/observability/route-map", () => ({
  resolveRouteId: () => "wallet_card_public",
}));

vi.mock("@/lib/motion/api-progress-tracker", () => ({
  trackRequestStart: vi.fn(),
  trackRequestEnd: vi.fn(),
}));

import { ApiService } from "@/lib/services/api-service";

const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

function at(pathname: string) {
  window.history.pushState({}, "", pathname);
}

describe("ApiService.apiFetch analytics exemption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    capacitorMocks.isNativePlatform.mockReturnValue(false);
    capacitorMocks.getPlatform.mockReturnValue("web");
    at("/");
  });

  // These tests drive window.location through history; leaving it on an exempt
  // path would silence analytics for any later file sharing this environment.
  afterEach(() => {
    at("/");
  });

  it("emits api_request_completed on a normal route", async () => {
    at("/one/wallet-card");
    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await ApiService.apiFetch("/api/one/wallet-card", { method: "GET" });

    expect(observabilityMocks.trackApiRequestCompleted).toHaveBeenCalled();
  });

  it("emits nothing while on the public scanned card page", async () => {
    at("/c/2f9c4a1b6d8e0f3a5c7b9d1e3f5a7c9b1d3e5f7");
    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await ApiService.apiFetch("/api/one/wallet-card/public/2f9c4a1b", {
      method: "GET",
    });

    expect(observabilityMocks.trackApiRequestCompleted).not.toHaveBeenCalled();
  });

  it("emits nothing on the public page even when the request fails", async () => {
    at("/c/2f9c4a1b6d8e0f3a5c7b9d1e3f5a7c9b1d3e5f7");
    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 404 }));

    await ApiService.apiFetch("/api/one/wallet-card/public/missing", {
      method: "GET",
    });

    expect(observabilityMocks.trackApiRequestCompleted).not.toHaveBeenCalled();
  });

  it("emits nothing on the public page when the network throws", async () => {
    at("/c/2f9c4a1b6d8e0f3a5c7b9d1e3f5a7c9b1d3e5f7");
    mockFetch.mockRejectedValueOnce(new Error("offline"));

    await expect(
      ApiService.apiFetch("/api/one/wallet-card/public/x", { method: "GET" }),
    ).rejects.toThrow();

    expect(observabilityMocks.trackApiRequestCompleted).not.toHaveBeenCalled();
  });
});
