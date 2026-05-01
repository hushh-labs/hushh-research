import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiJson, mockTrackEvent } = vi.hoisted(() => ({
  mockApiJson: vi.fn(),
  mockTrackEvent: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhAccount: {
    deleteAccount: vi.fn(),
  },
}));

vi.mock("@/lib/services/api-client", () => ({
  apiJson: mockApiJson,
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: mockTrackEvent,
}));

import { AccountService } from "@/lib/services/account-service";

describe("AccountService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
