/** Direct owner turns never retry private work on the hub after a named failure. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSseResponse } from "../utils/test-helpers";

const capacitorMocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  getPlatform: vi.fn(() => "web"),
  request: vi.fn(),
}));

const ownerPodMocks = vi.hoisted(() => ({
  verifyHubSignature: vi.fn(),
  loadPinnedEndpoint: vi.fn(),
  refreshEndpointFromHub: vi.fn(),
  currentPodSession: vi.fn(),
  revokeAtPod: vi.fn(),
}));

vi.mock("@/lib/services/owner-pod-crypto", () => ({ verifyHubSignature: ownerPodMocks.verifyHubSignature }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: capacitorMocks.isNativePlatform,
    getPlatform: capacitorMocks.getPlatform,
  },
  CapacitorHttp: { request: capacitorMocks.request },
  registerPlugin: vi.fn(() => ({})),
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
  OwnerPodError: Error,
  loadPinnedEndpoint: ownerPodMocks.loadPinnedEndpoint,
  refreshEndpointFromHub: ownerPodMocks.refreshEndpointFromHub,
  currentPodSession: ownerPodMocks.currentPodSession,
  currentPodConnection: async () => ({
    endpoint: await ownerPodMocks.loadPinnedEndpoint(),
    session: await ownerPodMocks.currentPodSession(),
  }),
  revokeAtPod: ownerPodMocks.revokeAtPod,
}));

import { ApiService } from "@/lib/services/api-service";

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

const PUPPY_INPUT = {
  hushhId: "ha1_owner", vaultOwnerToken: "synthetic-owner", message: "hi",
  conversationId: "puppy-chat-1", puppyDeviceId: "tdv_mac_1",
  history: [] as Array<{ role: "user" | "assistant"; content: string }>,
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

describe("ApiService owner-direct pod path", () => {
  beforeEach(() => {
    vi.spyOn(ApiService, "getPersonalAgentStatus").mockResolvedValue({
      hostingMode: "shared", state: "active", hushhId: "ha1_owner",
    });
    mockFetch.mockReset();
    ownerPodMocks.loadPinnedEndpoint.mockReset();
    ownerPodMocks.currentPodSession.mockReset();
    ownerPodMocks.refreshEndpointFromHub.mockReset();
    ownerPodMocks.refreshEndpointFromHub.mockRejectedValue(
      Object.assign(new Error("POD_DIRECT_NOT_READY"), { code: "ENDPOINT_UNAVAILABLE:POD_DIRECT_NOT_READY" }),
    );
    ownerPodMocks.revokeAtPod.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not dispatch pod adoption after its initiating owner changed during token lookup", async () => {
    let current = true;
    let resolve!: (value: string) => void;
    const promise = new Promise<string>((done) => { resolve = done; });
    vi.spyOn(ApiService, "getFirebaseToken").mockReturnValue(promise);
    const request = ApiService.adoptOrphanPod({ isEffectCurrent: () => current });
    current = false;
    resolve("synthetic-token");
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([false, true])("routes chat/history through pod admission without hub fallback (stream=%s)", async (streaming) => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    const stream = vi.spyOn(ApiService, "apiFetchStream").mockResolvedValue(new Response("stream"));
    mockFetch.mockResolvedValue(json({ conversations: [] }));
    if (streaming) mockFetch.mockResolvedValue(json({}, 503));
    const path = streaming ? "/api/one/agent-chat" : "/api/one/agent-chat/conversations/uid-owner";
    await ApiService.agentChatRequest(path, {
      body: streaming ? JSON.stringify({ messages: [], forwardedProps: {} }) : undefined,
      method: streaming ? "POST" : "GET", headers: { Authorization: "Bearer hub-owner", "X-Hussh-Chat-Key": "synthetic-derived" },
    }, streaming);
    const calls = streaming ? stream.mock.calls : mockFetch.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(`${POD_URL}${path.replace("/api/one/", "/api/one/pod/")}`);
    const headers = new Headers(calls[0][1]?.headers);
    expect(calls[0][1]?.credentials).toBe("omit");
    expect(headers.get("Authorization")).toBe("Bearer pst1.claims.mac");
    expect(headers.get("X-Hussh-Chat-Key")).toBe("synthetic-derived");
    expect(ApiService.getPersonalAgentStatus).not.toHaveBeenCalled();
    ownerPodMocks.currentPodSession.mockRejectedValueOnce(new Error("Pod offline"));
    await expect(ApiService.agentChatRequest(path, {}, streaming)).rejects.toThrow("Pod offline");
    expect(calls).toHaveLength(1);
  });

  it("sends only a bodyless grant request to the hub and refuses a changed signed endpoint", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    ownerPodMocks.verifyHubSignature.mockResolvedValue(undefined);
    const stream = vi.spyOn(ApiService, "apiFetchStream").mockResolvedValue(new Response("stream"));
    mockFetch.mockResolvedValue(json({ endpoint: PIN, dataDoorGrants: { email: "scoped-synthetic" } }));
    const init = { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "private synthetic" }], forwardedProps: { runtimeCredential: "synthetic-private-key" } }) };
    await ApiService.agentChatRequest("/api/one/agent-chat", init, true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain("/api/one/u/ha1_owner/chat-grants");
    expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
    expect(JSON.parse(String(stream.mock.calls[0][1]?.body))).toMatchObject({ forwardedProps: { dataDoorGrants: { email: "scoped-synthetic" }, runtimeCredential: "synthetic-private-key" } });
    expect(ownerPodMocks.verifyHubSignature).toHaveBeenCalled();
    mockFetch.mockResolvedValue(json({ endpoint: { ...PIN, podKeyId: "replacement" }, dataDoorGrants: {} }));
    await expect(ApiService.agentChatRequest("/api/one/agent-chat", init, true)).rejects.toThrow("POD_ASSIGNMENT_CHANGED");
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("requires explicit Shared authority when no admitted pod is pinned", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(null);
    vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValueOnce({ hostingMode: "unknown" });
    await expect(ApiService.agentChatRequest("/api/one/agent-chat", {})).rejects.toThrow("AGENT_PRIVATE_RUNTIME_REQUIRED");
    expect(mockFetch).not.toHaveBeenCalled();
    mockFetch.mockResolvedValue(json({}));
    await ApiService.agentChatRequest("/api/one/agent-chat", {});
    expect(mockFetch.mock.calls[0][0]).toBe("/api/one/agent-chat");
  });

  it("dials the pinned pod with the pod session and never touches the hub", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    vi.spyOn(ApiService, "activatePuppyWhenIdle").mockResolvedValue(undefined);
    mockFetch.mockResolvedValue(createSseResponse(['event: done\ndata: {"model":"local","modelReported":true,"provider":"puppy","grounded":false,"runtimeMode":"puppy_relay"}\n\n']));

    await ApiService.streamPuppyPodTurn({ ...PUPPY_INPUT, onToken: vi.fn() });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${POD_URL}/api/one/pod/turn/stream`);
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer pst1.claims.mac");
    expect(headers.get("X-Consent-Token")).toBeNull();
    expect(JSON.parse(String(init.body)).runtimeCredential).toBeUndefined();
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes("/api/one/u/"))).toBe(false);
  });

  it("has no hub turn or close door left to fall back to", () => {
    expect("runPodTurn" in ApiService).toBe(false);
    expect("closePodConversation" in ApiService).toBe(false);
  });

  it.each([
    ["ready", false, "ready", true],
    ["busy", false, "busy", false],
    ["ready", true, "busy", false],
    ["offline", false, "offline", false],
    [undefined, false, "offline", false],
  ])("uses the pod's reported relay state (%s, busy=%s)", async (state, busy, expected, ready) => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    mockFetch.mockResolvedValue(json({
      subjects: [{ subjectId: "tdv_mac_1", state: "trusted", scopes: ["puppy.inference"] }],
      puppy: { links: [{ deviceId: "tdv_mac_1", state, busy }] },
    }));
    await expect(ApiService.getPuppyRelayStatus("tdv_mac_1")).resolves.toMatchObject({
      state: expected, inference_ready: ready,
    });
  });

  it("discovers a verified BYOC endpoint before the first direct turn", async () => {
    vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue({
      hostingMode: "byoc", state: "active", hushhId: "ha1_owner",
    });
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValueOnce(null).mockResolvedValue(PIN);
    ownerPodMocks.refreshEndpointFromHub.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    vi.spyOn(ApiService, "activatePuppyWhenIdle").mockResolvedValue(undefined);
    mockFetch.mockResolvedValue(createSseResponse(['event: done\ndata: {"model":"local","modelReported":true,"provider":"puppy","grounded":false,"runtimeMode":"puppy_relay"}\n\n']));

    await ApiService.streamPuppyPodTurn({ ...PUPPY_INPUT, onToken: vi.fn() });

    expect(ownerPodMocks.refreshEndpointFromHub).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe(`${POD_URL}/api/one/pod/turn/stream`);
  });

  it("refuses a pin that names another owner's pod", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue({ ...PIN, hushhId: "ha1_other" });
    vi.spyOn(ApiService, "activatePuppyWhenIdle").mockResolvedValue(undefined);

    await expect(ApiService.streamPuppyPodTurn({ ...PUPPY_INPUT, onToken: vi.fn() })).rejects.toThrow(
      "POD_DIRECT_UNAVAILABLE:OWNER_MISMATCH",
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(ownerPodMocks.currentPodSession).not.toHaveBeenCalled();
  });

  it("refuses Puppy when no matching BYOC pod is pinned and never falls back to the hub", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(null);
    vi.spyOn(ApiService, "activatePuppyWhenIdle").mockResolvedValue(undefined);

    await expect(ApiService.streamPuppyPodTurn({ ...PUPPY_INPUT, onToken: vi.fn() }))
      .rejects.toThrow("PUPPY_DIRECT_BYOC_REQUIRED");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(ownerPodMocks.currentPodSession).not.toHaveBeenCalled();
  });

  it("names a direct refusal instead of falling back to the hub", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    vi.spyOn(ApiService, "activatePuppyWhenIdle").mockResolvedValue(undefined);
    const turn = () => ApiService.streamPuppyPodTurn({ ...PUPPY_INPUT, onToken: vi.fn() });

    mockFetch.mockResolvedValueOnce(json({ detail: { code: "PUPPY_OFFLINE", reason: "device not linked" } }, 409));
    await expect(turn()).rejects.toThrow("PUPPY_OFFLINE");

    mockFetch.mockResolvedValueOnce(json({ detail: { code: "revoked", message: "no" } }, 403));
    await expect(turn()).rejects.toThrow("AGENT_NOT_YOURS:revoked");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.every(([u]) => String(u).startsWith(POD_URL))).toBe(true);
  });

  it("names a session that could not be opened", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockRejectedValue(new Error("POD_ADMISSION_REFUSED:stale_version"));
    vi.spyOn(ApiService, "activatePuppyWhenIdle").mockResolvedValue(undefined);

    await expect(ApiService.streamPuppyPodTurn({ ...PUPPY_INPUT, onToken: vi.fn() })).rejects.toThrow(
      "POD_DIRECT_UNAVAILABLE:POD_ADMISSION_REFUSED:stale_version",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("streams fragmented Puppy tokens through the admitted pod and keeps terminal errors terminal", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    vi.spyOn(ApiService, "activatePuppyWhenIdle").mockResolvedValue(undefined);
    mockFetch.mockResolvedValueOnce(createSseResponse([
      'event: token\ndata: {"text":"Hello',
      ' "}\n\nevent: token\ndata: {"text":"world"}\n\n',
      'event: done\ndata: {"model":"local-m","modelReported":true,"provider":"puppy","grounded":false,"runtimeMode":"puppy_relay"}\n\n',
    ]));
    const tokens: string[] = [];
    const input = {
      ...PUPPY_INPUT, onToken: (text: string) => tokens.push(text),
    };
    const done = await ApiService.streamPuppyPodTurn(input);
    expect(tokens).toEqual(["Hello ", "world"]);
    expect(done.model).toBe("local-m");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(`${POD_URL}/api/one/pod/turn/stream`);
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toMatchObject({
      runtimeProvider: "puppy", puppyDeviceId: "tdv_mac_1", conversationId: "puppy-chat-1",
    });
    mockFetch.mockResolvedValueOnce(createSseResponse(['event: error\ndata: {"code":"PUPPY_OFFLINE"}\n\n']));
    await expect(ApiService.streamPuppyPodTurn(input)).rejects.toThrow("PUPPY_OFFLINE");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each([true, false, "offline", "deadline"])("bounds authoritative cancellation after abort or inference deadline (stopped=%s)", async (stopped) => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    vi.spyOn(ApiService, "activatePuppyWhenIdle").mockResolvedValue(undefined);
    const caller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      if (_url.endsWith("/turn/cancel")) return stopped === "offline"
        ? new Promise<Response>(() => {}) // a stuck admission/transport cannot strand the UI
        : Promise.resolve(json({ state: stopped === true || stopped === "deadline" ? "stopped" : "unconfirmed" }));
      transportSignal = init.signal ?? undefined;
      return Promise.resolve(createSseResponse([], transportSignal));
    });
    const turn = ApiService.streamPuppyPodTurn({
      ...PUPPY_INPUT, onToken: vi.fn(), signal: caller.signal,
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(transportSignal?.aborted).toBe(false);
    if (stopped !== "deadline") caller.abort(new DOMException("owner cancelled", "AbortError"));
    const outcome = stopped === "deadline" ? expect(turn).rejects.toMatchObject({ name: "TimeoutError" })
      : stopped === true ? expect(turn).rejects.toMatchObject({ name: "AbortError" })
      : expect(turn).rejects.toThrow("PUPPY_CANCEL_UNCONFIRMED");
    if (stopped === "deadline") await vi.advanceTimersByTimeAsync(170_000);
    if (stopped === "offline") await vi.advanceTimersByTimeAsync(12_000);
    await outcome;
    expect(transportSignal?.aborted).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const started = mockFetch.mock.calls[0][1] as RequestInit;
    const cancellation = mockFetch.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(cancellation.body))).toEqual({
      requestId: new Headers(started.headers).get("x-request-id"), puppyDeviceId: "tdv_mac_1",
    });
    expect(new Headers(cancellation.headers).get("Authorization")).toBe(`Bearer ${SESSION.session}`);
  });

  it.each([false, true])("preserves inference time after cold admission without late dispatch (cancel=%s)", async (cancel) => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    let admit!: (session: typeof SESSION) => void;
    ownerPodMocks.currentPodSession.mockReturnValue(new Promise((resolve) => { admit = resolve; }));
    const activate = vi.spyOn(ApiService, "activatePuppyWhenIdle").mockResolvedValue(undefined);
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      if (_url.endsWith("/turn/cancel")) return Promise.resolve(json({ state: "stopped" }));
      return Promise.resolve(createSseResponse(
        ['event: done\ndata: {"model":"local","modelReported":true}\n\n'], init.signal, 40_000,
      ));
    });
    const caller = new AbortController();
    const onDispatch = vi.fn();
    const turn = ApiService.streamPuppyPodTurn({
      ...PUPPY_INPUT, onToken: vi.fn(), signal: caller.signal, onDispatch,
    });
    const outcome = cancel ? expect(turn).rejects.toMatchObject({ name: "AbortError" })
      : expect(turn).resolves.toMatchObject({ model: "local" });
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(172_000);
    expect(mockFetch).not.toHaveBeenCalled();
    if (cancel) {
      caller.abort(new DOMException("owner cancelled", "AbortError"));
      await outcome;
    }
    admit(SESSION);
    await vi.advanceTimersByTimeAsync(40_000);
    if (!cancel) await outcome;
    expect(mockFetch).toHaveBeenCalledTimes(cancel ? 0 : 1);
    expect(onDispatch).toHaveBeenCalledTimes(cancel ? 0 : 1);
  });

});

describe("ApiService.revokeTrustedDeviceEverywhere", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    ownerPodMocks.loadPinnedEndpoint.mockReset();
    ownerPodMocks.revokeAtPod.mockReset();
  });

  it("fences hub issuance first and revokes the issued-version ceiling at the pod", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    const pending = { intentId: "pti_1", subjectId: "tdv_mac_1", atVersion: 1, queuedAt: 1, couriered: true };
    ownerPodMocks.revokeAtPod.mockResolvedValue({ delivered: false, pending });
    mockFetch.mockResolvedValue(
      json({ success: true, device_id: "tdv_mac_1", podBindingVersion: 7 })
    );

    const result = await ApiService.revokeTrustedDeviceEverywhere("tdv_mac_1");

    expect(ownerPodMocks.revokeAtPod).toHaveBeenCalledWith(
      "uid-owner",
      "tdv_mac_1",
      expect.anything(),
      { atVersion: 7 }
    );
    expect(mockFetch.mock.invocationCallOrder[0]).toBeLessThan(
      ownerPodMocks.revokeAtPod.mock.invocationCallOrder[0]
    );
    expect(result.pod).toEqual({ delivered: false, pending });
    expect(result.hub.ok).toBe(true);
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      "/api/account/trusted-devices/tdv_mac_1"
    );
  });

  it.each(["refused", "unpinned"])("keeps revocation authority at the hub (%s)", async (boundary) => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(boundary === "refused" ? PIN : null);
    mockFetch.mockResolvedValue(boundary === "refused" ? json({ detail: "refused" }, 403) : json({ success: true }));
    const result = await ApiService.revokeTrustedDeviceEverywhere("tdv_mac_1");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.hub.ok).toBe(boundary !== "refused");
    expect(ownerPodMocks.revokeAtPod).not.toHaveBeenCalled();
    if (boundary === "unpinned") expect(result.pod).toEqual({ delivered: false, pending: null, unpinned: true });
  });
});
