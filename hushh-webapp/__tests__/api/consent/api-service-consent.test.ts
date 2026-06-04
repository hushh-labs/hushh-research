import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ── Route-level mocks (hoisted, apply before route module is imported) ────────
vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://mock-backend",
}));

vi.mock("@/app/api/_utils/hot-get-json-cache", () => ({
  createHotGetJsonCache: () => ({
    read:          vi.fn(() => null),
    getInflight:   vi.fn(() => null),
    setInflight:   vi.fn(),
    write:         vi.fn(),
    clearInflight: vi.fn(),
  }),
}));

vi.mock("@/app/api/_utils/request-id", () => ({
  resolveRequestId:      () => "test-rid",
  createUpstreamHeaders: (_id: string, h: Record<string, string>) => h,
  withRequestIdJson: (_id: string, body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      status: (init?.status as number) ?? 200,
      headers: { "content-type": "application/json" },
    }),
}));

// Move mocks to the top-level scope to ensure they apply before imports
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
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
    getIdToken: vi.fn().mockResolvedValue("firebase_test_token"),
  },
}));

// Import ApiService once at the top to avoid re-importing issues inside tests
import { ApiService } from "../../../lib/services/api-service";

describe("ApiService consent token plumbing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Re-mock global fetch to clear spy state before each test
    vi.stubGlobal("fetch", vi.fn());
  });

  it("fails fast for protected consent methods when token is missing", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);

    const pendingRes = await ApiService.getPendingConsents("user_123", "");
    const historyRes = await ApiService.getConsentHistory("user_123", "", 1, 50);
    const approveRes = await ApiService.approvePendingConsent({
      userId: "user_123",
      requestId: "req_1",
      vaultOwnerToken: "",
    });
    const denyRes = await ApiService.denyPendingConsent({
      userId: "user_123",
      requestId: "req_1",
      vaultOwnerToken: "",
    });

    expect(pendingRes.status).toBe(401);
    expect(historyRes.status).toBe(401);
    expect(approveRes.status).toBe(401);
    expect(denyRes.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends Authorization header when token is provided", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await ApiService.getPendingConsents("user_123", "vault_token_abc");
    await ApiService.getConsentHistory("user_123", "vault_token_abc", 1, 50);
    await ApiService.approvePendingConsent({
      userId: "user_123",
      requestId: "req_1",
      vaultOwnerToken: "vault_token_abc",
    });
    await ApiService.denyPendingConsent({
      userId: "user_123",
      requestId: "req_1",
      vaultOwnerToken: "vault_token_abc",
    });

    const calls = fetchSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(4);

    for (const [, options] of calls) {
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers?.Authorization).toBe("Bearer vault_token_abc");
    }
  });
});

// ── Timeline-expiry enforcement proof ─────────────────────────────────────────
// Tests the GET /api/consent/active route handler directly.

function makeActiveRequest(userId = "user-123"): NextRequest {
  return new Request(
    `http://localhost/api/consent/active?userId=${userId}`,
    { headers: { Authorization: "Bearer test-token" } }
  ) as unknown as NextRequest;
}

function backendResponse(items: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ items }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/consent/active — inline timeline-expiry enforcement", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // AbortSignal.timeout may be absent in older jsdom — provide a safe stub.
    if (typeof AbortSignal.timeout !== "function") {
      vi.stubGlobal("AbortSignal", {
        ...AbortSignal,
        timeout: () => new AbortController().signal,
      });
    }
  });

  it("returns 401 when an item carries an expired expires_at (Unix seconds)", async () => {
    const expiredSecs = Math.floor((Date.now() - 3_600_000) / 1_000); // 1 h ago
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      backendResponse([{ id: "c1", expires_at: expiredSecs }])
    ));

    const { GET } = await import("@/app/api/consent/active/route");
    const res = await GET(makeActiveRequest());

    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/expired/i);
  });

  it("returns 401 when an item carries an ISO-string expires_at in the past", async () => {
    const expiredIso = new Date(Date.now() - 7_200_000).toISOString(); // 2 h ago
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      backendResponse([{ id: "c2", expires_at: expiredIso }])
    ));

    const { GET } = await import("@/app/api/consent/active/route");
    const res = await GET(makeActiveRequest());

    expect(res.status).toBe(401);
  });

  it("returns 401 when an item's issued_at exceeds the 24-hour policy window", async () => {
    const staleSecs = Math.floor((Date.now() - 25 * 3_600_000) / 1_000); // 25 h ago
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      backendResponse([{ id: "c3", issued_at: staleSecs }])
    ));

    const { GET } = await import("@/app/api/consent/active/route");
    const res = await GET(makeActiveRequest());

    expect(res.status).toBe(401);
  });

  it("returns 200 when all items have a future expires_at", async () => {
    const futureSecs = Math.floor((Date.now() + 3_600_000) / 1_000); // 1 h from now
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      backendResponse([{ id: "c4", expires_at: futureSecs }])
    ));

    const { GET } = await import("@/app/api/consent/active/route");
    const res = await GET(makeActiveRequest());

    expect(res.status).toBe(200);
  });

  it("returns 200 when items have no timestamp fields (no expiry data to evaluate)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      backendResponse([{ id: "c5", scope: "read" }])
    ));

    const { GET } = await import("@/app/api/consent/active/route");
    const res = await GET(makeActiveRequest());

    expect(res.status).toBe(200);
  });

  it("returns 400 when userId query param is absent", async () => {
    const { GET } = await import("@/app/api/consent/active/route");
    const req = new Request("http://localhost/api/consent/active") as unknown as NextRequest;
    const res = await GET(req);

    expect(res.status).toBe(400);
  });
});
// ── End timeline-expiry enforcement proof ─────────────────────────────────────