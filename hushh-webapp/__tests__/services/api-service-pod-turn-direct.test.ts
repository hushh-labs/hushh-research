/**
 * A pinned owner dials their pod directly; an unpinned one keeps the hub path.
 *
 * The property that matters is the absence: on a pinned turn no request reaches
 * `/api/one/u/...` at all, the bearer is the pod session (never a Firebase or hub
 * token), and a direct failure is NAMED rather than quietly retried on the hub.
 * The per-call ceiling is also pinned here, because the ladder is only a ladder
 * if the outermost rung (this client) sits above the ones below it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitorMocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  getPlatform: vi.fn(() => "web"),
  request: vi.fn(),
}));

const ownerPodMocks = vi.hoisted(() => ({
  loadPinnedEndpoint: vi.fn(),
  currentPodSession: vi.fn(),
  revokeAtPod: vi.fn(),
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
  Kai: {
    addListener: vi.fn(),
    streamPortfolioImport: vi.fn(),
    streamPortfolioImportRun: vi.fn(),
    streamPortfolioAnalyzeLosers: vi.fn(),
    streamKaiAnalysis: vi.fn(),
    cancelKaiAnalysisStream: vi.fn(),
  },
  PORTFOLIO_STREAM_EVENT: "portfolio_stream",
  KAI_STREAM_EVENT: "kai_stream",
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getIdToken: vi.fn(async () => "firebase-token"),
    getCurrentUser: vi.fn(() => ({ uid: "uid-owner" })),
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

vi.mock("@/lib/services/owner-pod-endpoint", () => ({
  loadPinnedEndpoint: ownerPodMocks.loadPinnedEndpoint,
  currentPodSession: ownerPodMocks.currentPodSession,
  revokeAtPod: ownerPodMocks.revokeAtPod,
}));

import { ApiService, POD_TURN_FETCH_TIMEOUT_MS } from "@/lib/services/api-service";

const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
const POD_URL = "https://one-pod-owner-abc.a.run.app";
const PIN = {
  hushhId: "ha1_owner",
  url: POD_URL,
  podKeyId: "podk_1",
  environment: "dev",
  endpointVersion: 1,
  signature: "ed25519.k.s",
  pinnedAt: 1,
};
const SESSION = {
  session: "pst1.claims.mac",
  sid: "pss_1",
  role: "app" as const,
  scopes: ["pkm.read"],
  epoch: 3,
  expiresAt: Date.now() + 10 * 3600 * 1000,
  version: 1,
  subjectId: "tdv_app_1",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ApiService.runPodTurn on the owner-direct path", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    ownerPodMocks.loadPinnedEndpoint.mockReset();
    ownerPodMocks.currentPodSession.mockReset();
    ownerPodMocks.revokeAtPod.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dials the pinned pod with the pod session and never touches the hub", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    mockFetch.mockResolvedValue(
      json({ text: "from your pod", model: "local", provider: "puppy", grounded: false, runtimeMode: "puppy_relay" }),
    );

    const result = await ApiService.runPodTurn({
      hushhId: "ha1_owner",
      message: "hello",
      runtimeProvider: "puppy",
      puppyDeviceId: "tdv_mac_1",
    });

    expect(result).toMatchObject({ hushhId: "ha1_owner", provider: "puppy", runtimeMode: "puppy_relay" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${POD_URL}/api/one/pod/turn`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer pst1.claims.mac");
    expect(headers["X-Consent-Token"]).toBeUndefined();
    expect(JSON.parse(String(init.body))).toMatchObject({ runtimeProvider: "puppy", puppyDeviceId: "tdv_mac_1" });
    expect(JSON.parse(String(init.body)).runtimeCredential).toBeUndefined();
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes("/api/one/u/"))).toBe(false);
  });

  it("keeps the hub path when nothing is pinned", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(null);
    mockFetch.mockResolvedValue(
      json({ text: "via hub", model: "gemini", provider: "gemini", grounded: true, runtimeMode: "user_adc" }),
    );

    await ApiService.runPodTurn({ hushhId: "ha1_owner", message: "hello" });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/one/u/ha1_owner/turn");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer firebase-token");
    expect(ownerPodMocks.currentPodSession).not.toHaveBeenCalled();
  });

  it("ignores a pin that names another owner's pod", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue({ ...PIN, hushhId: "ha1_other" });
    mockFetch.mockResolvedValue(json({ text: "via hub", model: "m", provider: "gemini", grounded: false, runtimeMode: "user_adc" }));

    await ApiService.runPodTurn({ hushhId: "ha1_owner", message: "hello" });

    expect(String(mockFetch.mock.calls[0][0])).toContain("/api/one/u/ha1_owner/turn");
    expect(ownerPodMocks.currentPodSession).not.toHaveBeenCalled();
  });

  it("names a direct refusal instead of falling back to the hub", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    mockFetch.mockResolvedValueOnce(json({ detail: { code: "PUPPY_OFFLINE", reason: "device not linked" } }, 409));

    await expect(
      ApiService.runPodTurn({ hushhId: "ha1_owner", message: "hello", runtimeProvider: "puppy", puppyDeviceId: "tdv_mac_1" }),
    ).rejects.toThrow("PUPPY_OFFLINE");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockResolvedValueOnce(json({ detail: { code: "revoked", message: "no" } }, 403));
    await expect(ApiService.runPodTurn({ hushhId: "ha1_owner", message: "hello" })).rejects.toThrow(
      "AGENT_NOT_YOURS:revoked",
    );
    expect(mockFetch.mock.calls.every(([u]) => String(u).startsWith(POD_URL))).toBe(true);
  });

  it("names a session that could not be opened", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockRejectedValue(new Error("POD_ADMISSION_REFUSED:stale_version"));

    await expect(ApiService.runPodTurn({ hushhId: "ha1_owner", message: "hello" })).rejects.toThrow(
      "POD_DIRECT_UNAVAILABLE:POD_ADMISSION_REFUSED:stale_version",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("gives the pod turn its own ceiling above the proxies", async () => {
    expect(POD_TURN_FETCH_TIMEOUT_MS).toBe(170_000);
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    let observedSignal: AbortSignal | undefined;
    mockFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init.signal ?? undefined;
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const turn = ApiService.runPodTurn({ hushhId: "ha1_owner", message: "hello" });
    const rejection = expect(turn).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60_000 + 1_000);
    expect(observedSignal?.aborted).toBe(false); // the default 60 s ceiling does not apply
    await vi.advanceTimersByTimeAsync(POD_TURN_FETCH_TIMEOUT_MS);
    expect(observedSignal?.aborted).toBe(true);
    await rejection;
  });
});

describe("ApiService.revokeTrustedDeviceEverywhere", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    ownerPodMocks.loadPinnedEndpoint.mockReset();
    ownerPodMocks.revokeAtPod.mockReset();
  });

  it("revokes at the pod first and reports pending delivery when the pod was unreachable", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    const pending = { intentId: "pti_1", subjectId: "tdv_mac_1", atVersion: 1, queuedAt: 1, couriered: true };
    ownerPodMocks.revokeAtPod.mockResolvedValue({ delivered: false, pending });
    mockFetch.mockResolvedValue(json({ success: true, device_id: "tdv_mac_1" }));

    const result = await ApiService.revokeTrustedDeviceEverywhere("tdv_mac_1");

    expect(ownerPodMocks.revokeAtPod).toHaveBeenCalledWith("uid-owner", "tdv_mac_1", expect.anything());
    expect(result.pod).toEqual({ delivered: false, pending });
    expect(result.hub.ok).toBe(true);
    expect(String(mockFetch.mock.calls[0][0])).toContain("/api/account/trusted-devices/tdv_mac_1");
  });

  it("runs only the hub leg without a pin", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(null);
    mockFetch.mockResolvedValue(json({ success: true }));

    const result = await ApiService.revokeTrustedDeviceEverywhere("tdv_mac_1");

    expect(ownerPodMocks.revokeAtPod).not.toHaveBeenCalled();
    expect(result.pod).toEqual({ delivered: false, pending: null, unpinned: true });
  });
});
