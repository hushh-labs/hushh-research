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
  it("uses the complete SMS roster and excludes unrelated recipient projections", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `recipient-${i}`);
    const calls = stubFetch({ smsContactUserIds: ids, recipients: [...ids, "outsider"].map((userId) => ({
      userId, displayName: userId, phoneVerified: true, canReceiveLocation: true,
      keyId: `key-${userId}`, publicKeyJwk: { kty: "EC" }, keyAlgorithm: "ECDH-P256-AES256-GCM",
    })) });
    const roster = await OneLocationService.getSmsRecipientRoster("tok");
    expect(roster.smsContactUserIds).toEqual(ids);
    expect(roster.recipients.map((r) => r.userId)).toEqual(ids);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/one/location/sms-contacts");
  });

  it("supports an IDs-only backend during rolling deployment without widening the circle", async () => {
    stubFetch({ smsContactUserIds: ["r1"] });
    const legacy = vi.spyOn(OneLocationService, "listRecipients").mockResolvedValue([
      { userId: "r1", displayName: "Contact", phoneVerified: true, canReceiveLocation: true, keyAlgorithm: "ECDH" },
      { userId: "other", displayName: "Other", phoneVerified: true, canReceiveLocation: true, keyAlgorithm: "ECDH" },
    ]);
    const roster = await OneLocationService.getSmsRecipientRoster("tok");
    expect(legacy).toHaveBeenCalledWith("tok");
    expect(roster.recipients.map((r) => r.userId)).toEqual(["r1"]);
  });

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

  it("adds and removes owner-scoped SMS contacts through the Location API", async () => {
    const addCalls = stubFetch({ smsContactUserIds: ["r1"] });
    await expect(
      OneLocationService.addSmsContact({
        vaultOwnerToken: "tok",
        recipientUserId: "r1",
      }),
    ).resolves.toEqual(["r1"]);
    expect(addCalls[0]).toMatchObject({
      url: "/api/one/location/sms-contacts",
      init: {
        method: "POST",
        body: JSON.stringify({ recipientUserId: "r1" }),
      },
    });

    const removeCalls = stubFetch({ smsContactUserIds: [] });
    await expect(
      OneLocationService.removeSmsContact({
        vaultOwnerToken: "tok",
        recipientUserId: "r1",
      }),
    ).resolves.toEqual([]);
    expect(removeCalls[0]).toMatchObject({
      url: "/api/one/location/sms-contacts/r1",
      init: { method: "DELETE" },
    });
  });

});
