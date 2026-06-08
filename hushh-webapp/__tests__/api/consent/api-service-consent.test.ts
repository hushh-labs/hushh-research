import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ── Route-level mock — must be hoisted before the route module is imported ────
vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://mock-backend",
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

// ── Security-header injection proof ──────────────────────────────────────────
// Calls the shipped POST handler directly and asserts that every response —
// success or error — carries the required security and privacy headers.

import { POST } from "@/app/api/consent/pending/approve/route";

function makeApproveRequest(body: Record<string, unknown>): NextRequest {
  return new Request("http://localhost/api/consent/pending/approve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer vault-owner-token",
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const REQUIRED_SECURITY_HEADERS: ReadonlyArray<[string, string]> = [
  ["x-frame-options",        "DENY"],
  ["x-content-type-options", "nosniff"],
  ["cache-control",          "no-store, no-cache, must-revalidate"],
  ["pragma",                 "no-cache"],
  ["referrer-policy",        "strict-origin-when-cross-origin"],
];

describe("POST /api/consent/pending/approve — security header injection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("stamps security headers on a 400 (missing userId)", async () => {
    const res = await POST(makeApproveRequest({ requestId: "req-1" }));

    expect(res.status).toBe(400);
    for (const [name, expected] of REQUIRED_SECURITY_HEADERS) {
      expect(res.headers.get(name)).toBe(expected);
    }
  });

  it("stamps security headers on a 400 (plaintext exportKey rejected)", async () => {
    const res = await POST(
      makeApproveRequest({ userId: "u-1", requestId: "r-1", exportKey: "raw" })
    );

    expect(res.status).toBe(400);
    for (const [name, expected] of REQUIRED_SECURITY_HEADERS) {
      expect(res.headers.get(name)).toBe(expected);
    }
  });

  it("stamps security headers on a 401 (missing Authorization header)", async () => {
    const req = new Request("http://localhost/api/consent/pending/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },       // no Authorization
      body: JSON.stringify({ userId: "u-1", requestId: "r-1" }),
    }) as unknown as NextRequest;

    const res = await POST(req);

    expect(res.status).toBe(401);
    for (const [name, expected] of REQUIRED_SECURITY_HEADERS) {
      expect(res.headers.get(name)).toBe(expected);
    }
  });

  it("stamps security headers on a 200 (backend success)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ consentToken: "ct_ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const res = await POST(
      makeApproveRequest({ userId: "u-1", requestId: "r-1" })
    );

    expect(res.status).toBe(200);
    for (const [name, expected] of REQUIRED_SECURITY_HEADERS) {
      expect(res.headers.get(name)).toBe(expected);
    }
  });

  it("stamps security headers on a backend error response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    );

    const res = await POST(
      makeApproveRequest({ userId: "u-1", requestId: "r-1" })
    );

    expect(res.status).toBe(404);
    for (const [name, expected] of REQUIRED_SECURITY_HEADERS) {
      expect(res.headers.get(name)).toBe(expected);
    }
  });

  it("X-Frame-Options is DENY on every response path (anti-clickjack)", async () => {
    // Spot-check the highest-value header across all four response paths.
    const cases: Array<[string, Record<string, unknown>]> = [
      ["missing userId",  { requestId: "r-1" }],
      ["plaintext key",   { userId: "u-1", requestId: "r-1", exportKey: "x" }],
    ];

    for (const [label, body] of cases) {
      const res = await POST(makeApproveRequest(body));
      expect(
        res.headers.get("x-frame-options"),
        `X-Frame-Options absent on path: ${label}`
      ).toBe("DENY");
    }
  });
});
// ── End security-header injection proof ──────────────────────────────────────