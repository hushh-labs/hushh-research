import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetOrIssueVaultOwnerToken } = vi.hoisted(() => ({
  mockGetOrIssueVaultOwnerToken: vi.fn(),
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    getOrIssueVaultOwnerToken: mockGetOrIssueVaultOwnerToken,
  },
}));

import { ensureKaiVaultOwnerToken, isKaiAuthStatus } from "@/lib/services/kai-token-guard";

describe("kai-token-guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  });

  describe("isKaiAuthStatus", () => {
    it("returns true for 401", () => {
      expect(isKaiAuthStatus(401)).toBe(true);
    });

    it("returns true for 403", () => {
      expect(isKaiAuthStatus(403)).toBe(true);
    });

    it("returns false for 200", () => {
      expect(isKaiAuthStatus(200)).toBe(false);
    });

    it("returns false for 500", () => {
      expect(isKaiAuthStatus(500)).toBe(false);
    });

    it("returns false for 404", () => {
      expect(isKaiAuthStatus(404)).toBe(false);
    });
  });

  describe("ensureKaiVaultOwnerToken", () => {
    it("returns the current token when it is still valid and forceRefresh is false", async () => {
      const token = await ensureKaiVaultOwnerToken({
        userId: "user-1",
        currentToken: "valid-token",
        currentExpiresAt: 1_000_000 + 120_000,
        forceRefresh: false,
      });

      expect(token).toBe("valid-token");
      expect(mockGetOrIssueVaultOwnerToken).not.toHaveBeenCalled();
    });

    it("refreshes when the token expires within the 60s buffer", async () => {
      mockGetOrIssueVaultOwnerToken.mockResolvedValue({
        token: "fresh-token",
        expiresAt: 1_200_000,
      });

      const onIssued = vi.fn();
      const token = await ensureKaiVaultOwnerToken({
        userId: "user-1",
        currentToken: "about-to-expire",
        currentExpiresAt: 1_000_000 + 30_000,
        onIssued,
      });

      expect(token).toBe("fresh-token");
      expect(mockGetOrIssueVaultOwnerToken).toHaveBeenCalledWith(
        "user-1",
        "about-to-expire",
        1_000_000 + 30_000
      );
      expect(onIssued).toHaveBeenCalledWith("fresh-token", 1_200_000);
    });

    it("refreshes when currentToken is null", async () => {
      mockGetOrIssueVaultOwnerToken.mockResolvedValue({
        token: "new-token",
        expiresAt: 2_000_000,
      });

      const token = await ensureKaiVaultOwnerToken({
        userId: "user-1",
        currentToken: null,
        currentExpiresAt: null,
      });

      expect(token).toBe("new-token");
      expect(mockGetOrIssueVaultOwnerToken).toHaveBeenCalledWith("user-1", null, null);
    });

    it("forces refresh when forceRefresh is true even if token is valid", async () => {
      mockGetOrIssueVaultOwnerToken.mockResolvedValue({
        token: "forced-token",
        expiresAt: 3_000_000,
      });

      const token = await ensureKaiVaultOwnerToken({
        userId: "user-1",
        currentToken: "still-valid",
        currentExpiresAt: 1_000_000 + 120_000,
        forceRefresh: true,
      });

      expect(token).toBe("forced-token");
      expect(mockGetOrIssueVaultOwnerToken).toHaveBeenCalledWith("user-1", null, null);
    });

    it("does not call onIssued when returning a cached token", async () => {
      const onIssued = vi.fn();
      await ensureKaiVaultOwnerToken({
        userId: "user-1",
        currentToken: "valid-token",
        currentExpiresAt: 1_000_000 + 120_000,
        onIssued,
      });

      expect(onIssued).not.toHaveBeenCalled();
    });
  });
});

// ── Expiration boundary — exact threshold corner cases ────────────────────────
//
// Production invariant (from kai-token-guard.ts):
//   TOKEN_REFRESH_BUFFER_MS = 60_000
//   hasUsableToken: Date.now() + 60_000 < expiresAt   (strict less-than)
//
// With Date.now() mocked to 1_000_000 the effective threshold is 1_060_000.
// Any expiresAt <= 1_060_000 triggers a refresh; > 1_060_000 does not.

describe("kai-token-guard — expiration boundary precision", () => {
  // Mocked clock is shared with the outer suite's beforeEach.
  // Each test restores mocks explicitly to stay isolated.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  });

  // ── 1 ms above the threshold — token is usable ───────────────────────────

  it("accepts a token expiring exactly 1 ms above the buffer threshold", async () => {
    // 1_060_000 < 1_060_001 → true (usable)
    const token = await ensureKaiVaultOwnerToken({
      userId: "user-1",
      currentToken: "one-ms-above",
      currentExpiresAt: 1_060_001,
    });

    expect(token).toBe("one-ms-above");
    expect(mockGetOrIssueVaultOwnerToken).not.toHaveBeenCalled();
  });

  // ── Exactly at the threshold — refresh required (strict < not <=) ─────────

  it("triggers refresh when token expiry is exactly at the buffer threshold", async () => {
    // 1_060_000 < 1_060_000 → false (strict less-than fails — boundary is open)
    mockGetOrIssueVaultOwnerToken.mockResolvedValue({
      token: "refreshed-at-threshold",
      expiresAt: 2_000_000,
    });

    const token = await ensureKaiVaultOwnerToken({
      userId: "user-1",
      currentToken: "at-threshold",
      currentExpiresAt: 1_060_000,
    });

    expect(token).toBe("refreshed-at-threshold");
    expect(mockGetOrIssueVaultOwnerToken).toHaveBeenCalledOnce();
  });

  // ── 1 ms below the threshold — refresh required ───────────────────────────

  it("triggers refresh when token expiry is exactly 1 ms below the buffer threshold", async () => {
    // 1_060_000 < 1_059_999 → false
    mockGetOrIssueVaultOwnerToken.mockResolvedValue({
      token: "refreshed-one-ms-below",
      expiresAt: 2_000_000,
    });

    const token = await ensureKaiVaultOwnerToken({
      userId: "user-1",
      currentToken: "one-ms-below",
      currentExpiresAt: 1_059_999,
    });

    expect(token).toBe("refreshed-one-ms-below");
    expect(mockGetOrIssueVaultOwnerToken).toHaveBeenCalledOnce();
  });

  // ── 1 second above the threshold — token is usable ───────────────────────

  it("accepts a token expiring 1 second above the buffer threshold", async () => {
    // 1_060_000 < 1_061_000 → true
    const token = await ensureKaiVaultOwnerToken({
      userId: "user-1",
      currentToken: "one-sec-above",
      currentExpiresAt: 1_061_000,
    });

    expect(token).toBe("one-sec-above");
    expect(mockGetOrIssueVaultOwnerToken).not.toHaveBeenCalled();
  });

  // ── 1 second below the threshold — refresh required ──────────────────────

  it("triggers refresh when token expiry is 1 second below the buffer threshold", async () => {
    // 1_060_000 < 1_059_000 → false
    mockGetOrIssueVaultOwnerToken.mockResolvedValue({
      token: "refreshed-one-sec-below",
      expiresAt: 2_000_000,
    });

    const token = await ensureKaiVaultOwnerToken({
      userId: "user-1",
      currentToken: "one-sec-below",
      currentExpiresAt: 1_059_000,
    });

    expect(token).toBe("refreshed-one-sec-below");
    expect(mockGetOrIssueVaultOwnerToken).toHaveBeenCalledOnce();
  });

  // ── Past expiry — token has already expired ───────────────────────────────

  it("triggers refresh when expiresAt equals Date.now() — already in the past", async () => {
    // 1_060_000 < 1_000_000 → false (token expired before the buffer window even starts)
    mockGetOrIssueVaultOwnerToken.mockResolvedValue({
      token: "post-expiry-token",
      expiresAt: 2_000_000,
    });

    const token = await ensureKaiVaultOwnerToken({
      userId: "user-1",
      currentToken: "already-expired",
      currentExpiresAt: 1_000_000,
    });

    expect(token).toBe("post-expiry-token");
    expect(mockGetOrIssueVaultOwnerToken).toHaveBeenCalledOnce();
  });

  // ── No drift — the boundary transition is sharp ───────────────────────────

  it("confirms no boundary drift: at-threshold refreshes, 1 ms above does not", async () => {
    mockGetOrIssueVaultOwnerToken.mockResolvedValue({
      token: "refreshed",
      expiresAt: 2_000_000,
    });

    // At threshold → must refresh.
    const atResult = await ensureKaiVaultOwnerToken({
      userId: "user-1",
      currentToken: "boundary-token",
      currentExpiresAt: 1_060_000,
    });
    expect(atResult).toBe("refreshed");
    expect(mockGetOrIssueVaultOwnerToken).toHaveBeenCalledOnce();

    // Reset state and re-pin the clock.
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    // 1 ms above → must NOT refresh — state transition is sharp, no drift.
    const aboveResult = await ensureKaiVaultOwnerToken({
      userId: "user-1",
      currentToken: "one-ms-above",
      currentExpiresAt: 1_060_001,
    });
    expect(aboveResult).toBe("one-ms-above");
    expect(mockGetOrIssueVaultOwnerToken).not.toHaveBeenCalled();
  });
});
// ── End expiration boundary coverage ─────────────────────────────────────────
