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
    mockFetch.mockResolvedValueOnce(json({
      subjects: [{ subjectId: "tdv_mac_1", state: "trusted", scopes: ["puppy.inference"] }],
      puppy: { links: [{ deviceId: "tdv_mac_1", busy: false }] },
    }));
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
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe(`${POD_URL}/api/one/pod/status`);
    const [url, init] = mockFetch.mock.calls[1] as [string, RequestInit];
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

  it("discovers a verified BYOC endpoint before the first direct turn", async () => {
    vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue({
      hostingMode: "byoc", state: "active", hushhId: "ha1_owner",
    });
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValueOnce(null).mockResolvedValue(PIN);
    ownerPodMocks.refreshEndpointFromHub.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    mockFetch.mockResolvedValue(json({ text: "direct", model: "m", provider: "gemini", grounded: false, runtimeMode: "pod" }));

    await ApiService.runPodTurn({ hushhId: "ha1_owner", message: "hello" });

    expect(ownerPodMocks.refreshEndpointFromHub).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe(`${POD_URL}/api/one/pod/turn`);
  });

  it("refuses a pin that names another owner's pod", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue({ ...PIN, hushhId: "ha1_other" });
    mockFetch.mockResolvedValue(json({ text: "via hub", model: "m", provider: "gemini", grounded: false, runtimeMode: "user_adc" }));

    await expect(ApiService.runPodTurn({ hushhId: "ha1_owner", message: "hello" })).rejects.toThrow(
      "POD_DIRECT_UNAVAILABLE:OWNER_MISMATCH",
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(ownerPodMocks.currentPodSession).not.toHaveBeenCalled();
  });

  it("refuses Puppy when no matching BYOC pod is pinned and never falls back to the hub", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(null);

    await expect(
      ApiService.runPodTurn({
        hushhId: "ha1_owner",
        message: "hello",
        runtimeProvider: "puppy",
        puppyDeviceId: "tdv_mac_1",
      }),
    ).rejects.toThrow("PUPPY_DIRECT_BYOC_REQUIRED");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(ownerPodMocks.currentPodSession).not.toHaveBeenCalled();
  });

  it("names a direct refusal instead of falling back to the hub", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    mockFetch.mockResolvedValueOnce(json({
      subjects: [{ subjectId: "tdv_mac_1", state: "trusted", scopes: ["puppy.inference"] }],
      puppy: { links: [{ deviceId: "tdv_mac_1", busy: false }] },
    }));
    mockFetch.mockResolvedValueOnce(json({ detail: { code: "PUPPY_OFFLINE", reason: "device not linked" } }, 409));

    await expect(
      ApiService.runPodTurn({ hushhId: "ha1_owner", message: "hello", runtimeProvider: "puppy", puppyDeviceId: "tdv_mac_1" }),
    ).rejects.toThrow("PUPPY_OFFLINE");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    mockFetch.mockResolvedValueOnce(
      json({ detail: { code: "revoked", message: "no" } }, 403)
    );
    await expect(
      ApiService.runPodTurn({ hushhId: "ha1_owner", message: "hello" })
    ).rejects.toThrow("AGENT_NOT_YOURS:revoked");
    expect(
      mockFetch.mock.calls.every(([u]) => String(u).startsWith(POD_URL))
    ).toBe(true);
  });

  it("names a session that could not be opened", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockRejectedValue(new Error("POD_ADMISSION_REFUSED:stale_version"));

    await expect(ApiService.runPodTurn({ hushhId: "ha1_owner", message: "hello" })).rejects.toThrow(
      "POD_DIRECT_UNAVAILABLE:POD_ADMISSION_REFUSED:stale_version",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("streams fragmented Puppy tokens through the admitted pod and keeps terminal errors terminal", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    vi.spyOn(ApiService, "activatePuppyWhenIdle").mockResolvedValue(undefined);
    const response = (parts: string[]) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    mockFetch.mockResolvedValueOnce(response([
      'event: token\ndata: {"text":"Hello',
      ' "}\n\nevent: token\ndata: {"text":"world"}\n\n',
      'event: done\ndata: {"model":"local-m","modelReported":true,"provider":"puppy","grounded":false,"runtimeMode":"puppy_relay"}\n\n',
    ]));
    const tokens: string[] = [];
    const input = {
      hushhId: "ha1_owner", vaultOwnerToken: "synthetic-owner", message: "hi",
      conversationId: "puppy-chat-1", puppyDeviceId: "tdv_mac_1",
      history: [{ role: "user" as const, content: "hi" }], onToken: (text: string) => tokens.push(text),
    };
    const done = await ApiService.streamPuppyPodTurn(input);
    expect(tokens).toEqual(["Hello ", "world"]);
    expect(done.model).toBe("local-m");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(`${POD_URL}/api/one/pod/turn/stream`);
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toMatchObject({
      runtimeProvider: "puppy", puppyDeviceId: "tdv_mac_1", conversationId: "puppy-chat-1",
    });
    mockFetch.mockResolvedValueOnce(response(['event: error\ndata: {"code":"PUPPY_OFFLINE"}\n\n']));
    await expect(ApiService.streamPuppyPodTurn(input)).rejects.toThrow("PUPPY_OFFLINE");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("aborts the direct HTTP stream after headers when the owner cancels", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    ownerPodMocks.currentPodSession.mockResolvedValue(SESSION);
    vi.spyOn(ApiService, "activatePuppyWhenIdle").mockResolvedValue(undefined);
    const caller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      transportSignal = init.signal ?? undefined;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          transportSignal?.addEventListener("abort", () => controller.error(transportSignal?.reason));
        },
      }), { headers: { "Content-Type": "text/event-stream" } }));
    });
    const turn = ApiService.streamPuppyPodTurn({
      hushhId: "ha1_owner", vaultOwnerToken: "synthetic-owner", message: "hi",
      conversationId: "puppy-chat-1", puppyDeviceId: "tdv_mac_1", history: [],
      onToken: vi.fn(), signal: caller.signal,
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(transportSignal?.aborted).toBe(false);
    caller.abort(new DOMException("owner cancelled", "AbortError"));
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(transportSignal?.aborted).toBe(true);
  });

  it("starts owner-approved Puppy activation while a cold pod session is opening", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    let admit!: (session: typeof SESSION) => void;
    ownerPodMocks.currentPodSession.mockReturnValue(new Promise((resolve) => { admit = resolve; }));
    const activate = vi.spyOn(ApiService, "activatePuppyWhenIdle").mockResolvedValue(undefined);
    mockFetch.mockResolvedValue(
      new Response('event: done\ndata: {"model":"local","modelReported":true}\n\n'),
    );
    const turn = ApiService.streamPuppyPodTurn({
      hushhId: "ha1_owner", vaultOwnerToken: "synthetic-owner", message: "hi",
      conversationId: "puppy-chat-1", puppyDeviceId: "tdv_mac_1", history: [], onToken: vi.fn(),
    });
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    expect(mockFetch).not.toHaveBeenCalled();
    admit(SESSION);
    await expect(turn).resolves.toMatchObject({ model: "local" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
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

  it("does not revoke or report completion after a refused hub revocation", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(PIN);
    mockFetch.mockResolvedValue(json({ detail: "refused" }, 403));
    const result = await ApiService.revokeTrustedDeviceEverywhere("tdv_mac_1");
    expect(result.hub.ok).toBe(false);
    expect(ownerPodMocks.revokeAtPod).not.toHaveBeenCalled();
  });

  it("runs only the hub leg without a pin", async () => {
    ownerPodMocks.loadPinnedEndpoint.mockResolvedValue(null);
    mockFetch.mockResolvedValue(json({ success: true }));

    const result = await ApiService.revokeTrustedDeviceEverywhere("tdv_mac_1");

    expect(ownerPodMocks.revokeAtPod).not.toHaveBeenCalled();
    expect(result.pod).toEqual({ delivered: false, pending: null, unpinned: true });
  });
});
