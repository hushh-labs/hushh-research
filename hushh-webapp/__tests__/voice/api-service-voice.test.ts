import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
  CapacitorHttp: {
    request: vi.fn(),
  },
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
    getIdToken: vi.fn().mockResolvedValue("firebase_token"),
  },
}));

const trackApiRequestCompleted = vi.fn();

vi.mock("@/lib/observability/client", () => ({
  toDurationBucket: () => "fast",
  trackApiRequestCompleted,
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/observability/route-map", () => ({
  resolveRouteId: () => "test-route",
}));

vi.mock("@/lib/motion/api-progress-tracker", () => ({
  trackRequestStart: vi.fn(),
  trackRequestEnd: vi.fn(),
}));

describe("ApiService voice planning contract", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.BACKEND_URL;
    delete process.env.NEXT_PUBLIC_BACKEND_URL;
    delete process.env.NEXT_PUBLIC_VOICE_DIRECT_BACKEND;
    delete process.env.NEXT_PUBLIC_VOICE_FORCE_PROXY;
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    trackApiRequestCompleted.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("sends app_state payload to /api/kai/voice/plan", async () => {
    const { ApiService } = await import("@/lib/services/api-service");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await ApiService.planKaiVoiceIntent({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      transcript: "Analyze NVDA",
      context: { route: "/kai/analysis" },
      voiceTurnId: "vturn_test_123",
      appState: {
        auth: { signed_in: true, user_id: "user_1" },
        vault: { unlocked: true, token_available: true, token_valid: true },
        route: { pathname: "/kai/analysis", screen: "analysis", subview: null },
        runtime: {
          analysis_active: false,
          analysis_ticker: null,
          analysis_run_id: null,
          import_active: false,
          import_run_id: null,
          busy_operations: [],
        },
        portfolio: { has_portfolio_data: true },
        voice: {
          available: true,
          tts_playing: false,
          last_tool_name: "clarify",
          last_ticker: null,
        },
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, request] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/api/kai/voice/plan");
    const headers = request?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer vault_token");
    expect(headers["X-Voice-Turn-Id"]).toBe("vturn_test_123");
    const body = JSON.parse(String(request?.body || "{}")) as Record<string, unknown>;
    expect(body.user_id).toBe("user_1");
    expect(body.transcript).toBe("Analyze NVDA");
    expect(body).toHaveProperty("app_state");
  });

  it("forwards planner v2 envelope fields for structured context and memory", async () => {
    const { ApiService } = await import("@/lib/services/api-service");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await ApiService.planKaiVoiceIntent({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      transcript: "open dashboard",
      plannerV2: {
        turnId: "vturn_1",
        transcriptFinal: "open dashboard",
        structuredContext: {
          route: { pathname: "/kai", screen: "home", subview: null },
        },
        memoryShort: [{ turn: "t1" }],
        memoryRetrieved: [{ memory: "m1" }],
      },
    });

    const [, request] = fetchSpy.mock.calls[0] ?? [];
    const body = JSON.parse(String(request?.body || "{}")) as Record<string, unknown>;
    expect(body.turn_id).toBe("vturn_1");
    expect(body.transcript_final).toBe("open dashboard");
    expect(body.context_structured).toEqual({
      route: { pathname: "/kai", screen: "home", subview: null },
    });
    expect(body.memory_short).toEqual([{ turn: "t1" }]);
    expect(body.memory_retrieved).toEqual([{ memory: "m1" }]);
  });

  it("forwards voice turn id header for TTS requests", async () => {
    const { ApiService } = await import("@/lib/services/api-service");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await ApiService.synthesizeKaiVoice({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      text: "hello",
      voiceTurnId: "vturn_tts_1",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, ttsRequest] = fetchSpy.mock.calls[0] ?? [];
    const ttsHeaders = ttsRequest?.headers as Record<string, string>;
    expect(ttsHeaders["X-Voice-Turn-Id"]).toBe("vturn_tts_1");
  });

  it("calls voice capability route with auth and turn id", async () => {
    const { ApiService } = await import("@/lib/services/api-service");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, reason: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await ApiService.getKaiVoiceCapability({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      voiceTurnId: "vturn_capability_1",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, request] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/api/kai/voice/capability");
    const headers = request?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer vault_token");
    expect(headers["X-Voice-Turn-Id"]).toBe("vturn_capability_1");
    const body = JSON.parse(String(request?.body || "{}")) as Record<string, unknown>;
    expect(body.user_id).toBe("user_1");
  });

  it("prefers direct backend transport for local backend in production mode", async () => {
    process.env.NODE_ENV = "production";
    process.env.BACKEND_URL = "http://localhost:8000";
    process.env.NEXT_PUBLIC_BACKEND_URL = "http://localhost:8000";
    const { ApiService } = await import("@/lib/services/api-service");
    const mode = ApiService.getVoiceTransportMode();
    expect(mode.mode).toBe("direct_backend");
    expect(mode.reason).toBe("local_backend_default_direct");
  });

  it("creates realtime session via voice route with auth and turn id", async () => {
    const { ApiService } = await import("@/lib/services/api-service");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ client_secret: "ephemeral_secret", model: "gpt-realtime", voice: "alloy" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await ApiService.createKaiRealtimeSession({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      voice: "alloy",
      voiceTurnId: "vturn_realtime_1",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, request] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/api/kai/voice/realtime/session");
    const headers = request?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer vault_token");
    expect(headers["X-Voice-Turn-Id"]).toBe("vturn_realtime_1");
  });

  it("does not fallback to proxy when direct backend mode is selected", async () => {
    process.env.BACKEND_URL = "https://voice.example.com";
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://voice.example.com";
    process.env.NEXT_PUBLIC_VOICE_DIRECT_BACKEND = "true";
    const { ApiService } = await import("@/lib/services/api-service");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("DIRECT_BACKEND_DOWN"));

    await expect(
      ApiService.synthesizeKaiVoice({
        userId: "user_1",
        vaultOwnerToken: "vault_token",
        text: "hello",
        voiceTurnId: "vturn_tts_fail_fast",
      })
    ).rejects.toThrow("DIRECT_BACKEND_DOWN");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not fallback to proxy when the backend is hosted and direct transport is explicit", async () => {
    process.env.BACKEND_URL = "https://voice.example.com";
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://voice.example.com";
    process.env.NEXT_PUBLIC_VOICE_DIRECT_BACKEND = "true";
    const { ApiService } = await import("@/lib/services/api-service");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("DIRECT_BACKEND_DOWN"));

    await expect(
      ApiService.synthesizeKaiVoice({
        userId: "user_1",
        vaultOwnerToken: "vault_token",
        text: "hello",
        voiceTurnId: "vturn_tts_force_realtime",
      })
    ).rejects.toThrow("DIRECT_BACKEND_DOWN");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not fallback to proxy after direct backend failure even without fail-fast flags", async () => {
    process.env.BACKEND_URL = "https://voice.example.com";
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://voice.example.com";
    process.env.NEXT_PUBLIC_VOICE_DIRECT_BACKEND = "true";
    const { ApiService } = await import("@/lib/services/api-service");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("DIRECT_BACKEND_DOWN"));

    await expect(
      ApiService.planKaiVoiceIntent({
        userId: "user_1",
        vaultOwnerToken: "vault_token",
        transcript: "Analyze NVDA",
      })
    ).rejects.toThrow("DIRECT_BACKEND_DOWN");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("records api completion metrics and request id headers for direct voice fetches", async () => {
    process.env.BACKEND_URL = "https://voice.example.com";
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://voice.example.com";
    process.env.NEXT_PUBLIC_VOICE_DIRECT_BACKEND = "true";
    window.history.pushState({}, "", "/profile/receipts");
    const { ApiService } = await import("@/lib/services/api-service");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await ApiService.planKaiVoiceIntent({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      transcript: "sync my receipts",
      voiceTurnId: "vturn_direct_metrics",
    });

    const [url, request] = fetchSpy.mock.calls[0] ?? [];
    const headers = request?.headers as Record<string, string>;

    expect(url).toBe("https://voice.example.com/api/kai/voice/plan");
    expect(headers["x-request-id"]).toBeTruthy();
    expect(trackApiRequestCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/kai/voice/plan",
        httpMethod: "POST",
        statusCode: 200,
        routeId: "test-route",
      })
    );
  });

  it("falls back to the Next.js proxy in development when backend URL is missing", async () => {
    process.env.NODE_ENV = "development";
    const { ApiService } = await import("@/lib/services/api-service");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await ApiService.planKaiVoiceIntent({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      transcript: "Analyze NVDA",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/kai/voice/plan");
  });

  it("honors explicit proxy routing in development without forcing direct backend", async () => {
    process.env.NODE_ENV = "development";
    process.env.BACKEND_URL = "http://localhost:8000";
    process.env.NEXT_PUBLIC_BACKEND_URL = "http://localhost:8000";
    process.env.NEXT_PUBLIC_VOICE_FORCE_PROXY = "true";
    const { ApiService } = await import("@/lib/services/api-service");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await ApiService.createKaiRealtimeSession({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      voice: "alloy",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/kai/voice/realtime/session");
  });
});
