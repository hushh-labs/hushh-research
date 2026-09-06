import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiJson, mockTrackEvent, mockNativeDeleteAccount, nativePlatform } =
  vi.hoisted(() => ({
  mockApiJson: vi.fn(),
  mockTrackEvent: vi.fn(),
    mockNativeDeleteAccount: vi.fn(),
    nativePlatform: { current: false },
  }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => nativePlatform.current,
    getPlatform: () => (nativePlatform.current ? "ios" : "web"),
  },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhAccount: {
    deleteAccount: mockNativeDeleteAccount,
  },
}));

vi.mock("@/lib/services/api-client", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly payload?: unknown,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  return {
    ApiError,
    apiJson: mockApiJson,
    apiErrorCode: (error: unknown) => {
      if (!(error instanceof ApiError)) return null;
      const payload = error.payload as
        | { code?: unknown; detail?: { code?: unknown } }
        | undefined;
      const code = payload?.code ?? payload?.detail?.code;
      return typeof code === "string" ? code : null;
    },
  };
});

vi.mock("@/lib/observability/client", () => ({
  trackEvent: mockTrackEvent,
}));

import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { AccountService } from "@/lib/services/account-service";

describe("AccountService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativePlatform.current = false;
  });

  describe("deleteAccount", () => {
    it("throws when no vault owner token is provided", async () => {
      await expect(AccountService.deleteAccount("")).rejects.toThrow(
        "VAULT_OWNER token required"
      );
    });

    it("calls the web proxy on non-native platforms with correct auth header", async () => {
      mockApiJson.mockResolvedValue({ success: true, account_deleted: true });

      const result = await AccountService.deleteAccount("vault-token-abc", "both");

      expect(mockApiJson).toHaveBeenCalledWith(
        "/api/account/delete",
        expect.objectContaining({
          method: "DELETE",
          headers: { Authorization: "Bearer vault-token-abc" },
          body: JSON.stringify({ target: "both" }),
        })
      );
      expect(result.success).toBe(true);
    });

    it("defaults target to 'both' when not specified", async () => {
      mockApiJson.mockResolvedValue({ success: true });

      await AccountService.deleteAccount("vault-token-abc");

      expect(mockApiJson).toHaveBeenCalledWith(
        "/api/account/delete",
        expect.objectContaining({
          body: JSON.stringify({ target: "both" }),
        })
      );
    });

    it("tracks account_delete_requested and account_delete_completed on success", async () => {
      mockApiJson.mockResolvedValue({ success: true });

      await AccountService.deleteAccount("vault-token-abc");

      expect(mockTrackEvent).toHaveBeenCalledWith("account_delete_requested", {
        result: "success",
      });
      expect(mockTrackEvent).toHaveBeenCalledWith("account_delete_completed", {
        result: "success",
        status_bucket: "2xx",
      });
    });

    it("tracks error event and rethrows on failure", async () => {
      mockApiJson.mockRejectedValue(new Error("Network failure"));

      await expect(AccountService.deleteAccount("vault-token-abc")).rejects.toThrow(
        "Network failure"
      );

      expect(mockTrackEvent).toHaveBeenCalledWith("account_delete_completed", {
        result: "error",
        status_bucket: "5xx",
      });
    });

    it("accepts investor-only deletion target", async () => {
      mockApiJson.mockResolvedValue({
        success: true,
        deleted_target: "investor",
        remaining_personas: ["ria"],
      });

      const result = await AccountService.deleteAccount("vault-token-abc", "investor");

      expect(mockApiJson).toHaveBeenCalledWith(
        "/api/account/delete",
        expect.objectContaining({
          body: JSON.stringify({ target: "investor" }),
        })
      );
      expect(result.remaining_personas).toEqual(["ria"]);
    });

    it("normalizes native bridge rejection data into a typed ApiError", async () => {
      nativePlatform.current = true;
      mockNativeDeleteAccount.mockRejectedValueOnce({
        message: "External resources must be removed first.",
        code: "ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING",
        data: {
          status: 409,
          payload: {
            detail: {
              code: "ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING",
            },
          },
        },
      });

      const error = await AccountService.deleteAccount(
        "vault-token-abc",
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 409,
        message: "External resources must be removed first.",
      });
      expect(apiErrorCode(error)).toBe(
        "ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING",
      );
    });
  });

  describe("resetAccount", () => {
    it("throws when no vault owner token is provided", async () => {
      await expect(AccountService.resetAccount("")).rejects.toThrow(
        "VAULT_OWNER token required"
      );
    });

    it("calls the reset proxy with the VAULT_OWNER authorization header", async () => {
      mockApiJson.mockResolvedValue({
        success: true,
        account_deleted: false,
        account_reset: true,
      });

      const result = await AccountService.resetAccount("vault-token-abc");

      expect(mockApiJson).toHaveBeenCalledWith(
        "/api/account/reset",
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: "Bearer vault-token-abc" },
        })
      );
      expect(result.account_reset).toBe(true);
      expect(result.account_deleted).toBe(false);
    });

    it("tracks account_reset_requested and account_reset_completed on success", async () => {
      mockApiJson.mockResolvedValue({ success: true, account_reset: true });

      await AccountService.resetAccount("vault-token-abc");

      expect(mockTrackEvent).toHaveBeenCalledWith("account_reset_requested", {
        result: "success",
      });
      expect(mockTrackEvent).toHaveBeenCalledWith("account_reset_completed", {
        result: "success",
        status_bucket: "2xx",
      });
    });

    it("tracks error event and rethrows on failure", async () => {
      mockApiJson.mockRejectedValue(new Error("Network failure"));

      await expect(AccountService.resetAccount("vault-token-abc")).rejects.toThrow(
        "Network failure"
      );

      expect(mockTrackEvent).toHaveBeenCalledWith("account_reset_completed", {
        result: "error",
        status_bucket: "5xx",
      });
    });
  });

  describe("exportData", () => {
    it("throws when no vault owner token is provided", async () => {
      await expect(AccountService.exportData("")).rejects.toThrow("VAULT_OWNER token required");
    });

    it("calls export route with VAULT_OWNER authorization header", async () => {
      mockApiJson.mockResolvedValue({
        success: true,
        exported_at: "2026-04-24T00:00:00Z",
        requested_target: "account",
      });

      const result = await AccountService.exportData("vault-token-abc");

      expect(mockApiJson).toHaveBeenCalledWith(
        "/api/account/export",
        expect.objectContaining({
          method: "GET",
          headers: {
            Authorization: "Bearer vault-token-abc",
          },
        })
      );
      expect(result.success).toBe(true);
      expect(result.requested_target).toBe("account");
    });
  });

  describe("email aliases", () => {
    it("lists aliases with VAULT_OWNER authorization", async () => {
      mockApiJson.mockResolvedValue({
        success: true,
        user_id: "user_1",
        aliases: [],
      });

      await AccountService.listEmailAliases("vault-token-abc");

      expect(mockApiJson).toHaveBeenCalledWith(
        "/api/account/email-aliases",
        expect.objectContaining({
          method: "GET",
          headers: { Authorization: "Bearer vault-token-abc" },
        })
      );
    });

    it("starts and confirms alias verification without Firebase-only auth", async () => {
      mockApiJson.mockResolvedValue({ success: true });

      await AccountService.startEmailAliasVerification(
        "vault-token-abc",
        "Original@Example.com"
      );
      await AccountService.confirmEmailAliasVerification(
        "vault-token-abc",
        "original@example.com",
        "123456"
      );

      expect(mockApiJson).toHaveBeenNthCalledWith(
        1,
        "/api/account/email-aliases/verification/start",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer vault-token-abc",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email: "Original@Example.com" }),
        })
      );
      expect(mockApiJson).toHaveBeenNthCalledWith(
        2,
        "/api/account/email-aliases/verification/confirm",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            email: "original@example.com",
            verification_code: "123456",
          }),
        })
      );
    });
  });
});
