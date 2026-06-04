import { beforeEach, describe, expect, it, vi } from "vitest";

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