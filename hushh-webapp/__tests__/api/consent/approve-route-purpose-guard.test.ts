/**
 * Approve route — isPurposeValid wiring + backward-compatibility proof
 *
 * Covers:
 *  1. isPurposeValid unit contract (allow-list, reject unknown/empty/non-string)
 *  2. Route accepts requests with no purpose (all existing callers — backward compat)
 *  3. Route accepts requests with a valid known purpose
 *  4. Route rejects requests with an unrecognised purpose string (400 before backend)
 *  5. Route does not forward the purpose field to the Python backend
 *  6. ApiService.approvePendingConsent sends purpose in the request body when provided
 *  7. ApiService.approvePendingConsent omits purpose when not provided
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPOST } from "../../utils/test-helpers";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "https://backend.test",
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
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
  AuthService: { getIdToken: vi.fn().mockResolvedValue("firebase_test_token") },
}));

import { isPurposeValid, CONSENT_APPROVE_PURPOSES } from "@/lib/consent/purpose-guard";

// ---------------------------------------------------------------------------
// Unit: isPurposeValid
// ---------------------------------------------------------------------------

describe("isPurposeValid — consent approve purpose guard", () => {
  it("accepts every member of CONSENT_APPROVE_PURPOSES", () => {
    for (const purpose of CONSENT_APPROVE_PURPOSES) {
      expect(isPurposeValid(purpose)).toBe(true);
    }
  });

  it("rejects an unknown string", () => {
    expect(isPurposeValid("unknown_purpose")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isPurposeValid("")).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isPurposeValid(undefined)).toBe(false);
  });

  it("rejects null", () => {
    expect(isPurposeValid(null)).toBe(false);
  });

  it("rejects a numeric value", () => {
    expect(isPurposeValid(42)).toBe(false);
  });

  it("rejects a boolean value", () => {
    expect(isPurposeValid(true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: approve route purpose guard
// ---------------------------------------------------------------------------

const MINIMAL_BODY = { userId: "user_test_001", requestId: "req_test_001" };
const AUTH_HEADER = { Authorization: "Bearer vault_owner_test_token" };

describe("approve route — purpose guard", () => {
  let POST: (req: ReturnType<typeof createMockPOST>) => Promise<Response>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import(
      "../../../app/api/consent/pending/approve/route"
    );
    POST = mod.POST as unknown as typeof POST;
  });

  it("accepts a request without purpose (backward compatibility — existing callers)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const req = createMockPOST(
      "/api/consent/pending/approve",
      MINIMAL_BODY,
      AUTH_HEADER
    );
    const res = await POST(req);
    expect(res.status).not.toBe(400);
  });

  it("accepts a request with a known valid purpose", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const req = createMockPOST(
      "/api/consent/pending/approve",
      { ...MINIMAL_BODY, purpose: "data_access" },
      AUTH_HEADER
    );
    const res = await POST(req);
    expect(res.status).not.toBe(400);
  });

  it("rejects an unrecognised purpose string with 400", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const req = createMockPOST(
      "/api/consent/pending/approve",
      { ...MINIMAL_BODY, purpose: "INVALID_PURPOSE_XYZ" },
      AUTH_HEADER
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/purpose/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not forward the purpose field to the Python backend", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const req = createMockPOST(
      "/api/consent/pending/approve",
      { ...MINIMAL_BODY, purpose: "analytics" },
      AUTH_HEADER
    );
    await POST(req);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, fetchOptions] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse((fetchOptions as RequestInit).body as string);
    expect(sentBody).not.toHaveProperty("purpose");
  });
});

// ---------------------------------------------------------------------------
// Integration: ApiService.approvePendingConsent purpose plumbing
// ---------------------------------------------------------------------------

describe("ApiService.approvePendingConsent — purpose field plumbing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("includes purpose in the request body when provided", async () => {
    const { ApiService } = await import("../../../lib/services/api-service");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    await ApiService.approvePendingConsent({
      userId: "user_test_001",
      requestId: "req_test_001",
      vaultOwnerToken: "vault_owner_test_token",
      purpose: "research",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.purpose).toBe("research");
  });

  it("omits purpose from the request body when not provided (existing callers)", async () => {
    const { ApiService } = await import("../../../lib/services/api-service");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    await ApiService.approvePendingConsent({
      userId: "user_test_001",
      requestId: "req_test_001",
      vaultOwnerToken: "vault_owner_test_token",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).not.toHaveProperty("purpose");
  });
});
