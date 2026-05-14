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
