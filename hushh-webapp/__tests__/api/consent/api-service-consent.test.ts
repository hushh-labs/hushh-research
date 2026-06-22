import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ── Route-level mocks (hoisted; fire before any route module is imported) ─────
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

// ── Timeline-expiry guard — expires_at contract ───────────────────────────────
// Directly invokes the GET route handler; no client-side stub needed.
// The guard is based on expires_at only — issued_at is NOT checked so that
// longer-lived grants (durationHours up to 8 760) are never incorrectly
// expired by a hardcoded ceiling.

function makeActiveRequest(userId = "user-123"): NextRequest {
  return new Request(
    `http://localhost/api/consent/active?userId=${userId}`,
    { headers: { Authorization: "Bearer tok" } },
  ) as unknown as NextRequest;
}

function backendOk(items: unknown[]): Response {
  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/consent/active — timeline-expiry guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // AbortSignal.timeout may be absent in some jsdom versions.
    if (typeof AbortSignal.timeout !== "function") {
      vi.stubGlobal("AbortSignal", {
        ...AbortSignal,
        timeout: () => new AbortController().signal,
      });
    }
  });

  // ── expired expires_at ────────────────────────────────────────────────────

  it("returns 401 when an item has an expired expires_at (Unix seconds)", async () => {
    const expiredSec = Math.floor((Date.now() - 3_600_000) / 1_000); // 1 h ago
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      backendOk([{ id: "c1", expires_at: expiredSec }]),
    ));

    const { GET } = await import("@/app/api/consent/active/route");
    const res = await GET(makeActiveRequest());

    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/expired/i);
  });

  it("returns 401 when an item has an ISO-string expires_at in the past", async () => {
    const expiredIso = new Date(Date.now() - 7_200_000).toISOString(); // 2 h ago
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      backendOk([{ id: "c2", expires_at: expiredIso }]),
    ));

    const { GET } = await import("@/app/api/consent/active/route");
    expect((await GET(makeActiveRequest())).status).toBe(401);
  });

  // ── valid multi-day active consent ────────────────────────────────────────

  it("returns 200 for a valid multi-day grant (expires_at 30 days from now)", async () => {
    // Proves the guard does not incorrectly expire longer-lived grants.
    const thirtyDaysFuture = Math.floor((Date.now() + 30 * 24 * 3_600_000) / 1_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      backendOk([{ id: "c3", expires_at: thirtyDaysFuture }]),
    ));

    const { GET } = await import("@/app/api/consent/active/route");
    expect((await GET(makeActiveRequest())).status).toBe(200);
  });

  it("returns 200 for a valid one-year grant (durationHours=8760)", async () => {
    // Maximum permitted durationHours from the approval model — must never
    // be blocked by the timeline guard.
    const oneYearFuture = Math.floor((Date.now() + 365 * 24 * 3_600_000) / 1_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      backendOk([{ id: "c4", expires_at: oneYearFuture }]),
    ));

    const { GET } = await import("@/app/api/consent/active/route");
    expect((await GET(makeActiveRequest())).status).toBe(200);
  });

  // ── missing timestamp fallback ────────────────────────────────────────────

  it("returns 200 when items carry no expires_at field (fallback — pass through)", async () => {
    // Items without expires_at are treated as still-valid; the guard only
    // fires when an explicit timestamp has already elapsed.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      backendOk([{ id: "c5", scope: "read" }]),
    ));

    const { GET } = await import("@/app/api/consent/active/route");
    expect((await GET(makeActiveRequest())).status).toBe(200);
  });

  it("returns 200 when expires_at is absent but issued_at is present and old", async () => {
    // issued_at alone must never trigger the guard — the check is on
    // expires_at only.  A 25-hour-old issued_at with no expires_at is valid.
    const oldIssuedSec = Math.floor((Date.now() - 25 * 3_600_000) / 1_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      backendOk([{ id: "c6", issued_at: oldIssuedSec }]),
    ));

    const { GET } = await import("@/app/api/consent/active/route");
    expect((await GET(makeActiveRequest())).status).toBe(200);
  });

  // ── existing guard preserved ──────────────────────────────────────────────

  it("returns 400 when userId is absent (existing validation guard preserved)", async () => {
    const { GET } = await import("@/app/api/consent/active/route");
    const req = new Request(
      "http://localhost/api/consent/active",
    ) as unknown as NextRequest;
    expect((await GET(req)).status).toBe(400);
  });
});
// ── End timeline-expiry guard ─────────────────────────────────────────────────
