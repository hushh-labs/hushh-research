// Mocks declared before any import that touches them — mirrors api-service-fetch.test.ts pattern
// (apiJson → ApiService.apiFetch → module apiFetch → global fetch on web path)
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { OneLocationService } from "@/lib/one-location/service";

// Capture outgoing requests by stubbing global fetch (apiJson wraps fetch).
function stubFetch(payload: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OneLocationService SOS additions", () => {
  it("createGrant sends reason when provided", async () => {
    const calls = stubFetch({ grant: { id: "g1" } });
    await OneLocationService.createGrant({
      vaultOwnerToken: "tok",
      recipientUserId: "r1",
      recipientKeyId: "k1",
      durationHours: 8,
      reason: "sos_panic",
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.reason).toBe("sos_panic");
    expect(body.durationHours).toBe(8);
  });

  it("createGrant omits reason when not provided", async () => {
    const calls = stubFetch({ grant: { id: "g1" } });
    await OneLocationService.createGrant({
      vaultOwnerToken: "tok",
      recipientUserId: "r1",
      recipientKeyId: "k1",
      durationHours: 2,
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect("reason" in body).toBe(false);
  });

  it("seedTrustedContacts POSTs to the seed endpoint and returns result", async () => {
    const calls = stubFetch({ result: { seeded: 3, existingCount: 0, skippedSelf: 0 } });
    const result = await OneLocationService.seedTrustedContacts({ vaultOwnerToken: "tok" });
    expect(calls[0].url).toContain("/api/one/location/seed-trusted");
    expect(calls[0].init.method).toBe("POST");
    expect(result.seeded).toBe(3);
  });
});
