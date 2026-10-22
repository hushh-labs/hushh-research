import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiJson, mockApiFetch, mockTrackEvent, mockNativeDeleteAccount, nativePlatform } =
  vi.hoisted(() => ({
  mockApiJson: vi.fn(),
  mockApiFetch: vi.fn(),
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

vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: mockApiFetch } }));

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
      const payload = {
        success: true,
        exported_at: "2026-04-24T00:00:00Z",
        requested_target: "account",
        data: { encrypted_pkm_recovery_segments: [{ ciphertext: "history" }] },
      };
      mockApiFetch.mockResolvedValue(Response.json(payload));
      const result = await AccountService.exportData("vault-token-abc");
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/api/account/export",
        expect.objectContaining({
          method: "GET",
          headers: { Authorization: "Bearer vault-token-abc" },
        }),
      );
      expect(result).toEqual(payload);
    });

    it.each([
      '{"success":true,"data":',
      JSON.stringify({ success: true }),
      JSON.stringify({ success: false, data: {} }),
      JSON.stringify({ success: true, data: [], requested_target: "account", exported_at: "2026-04-24T00:00:00Z" }),
    ])("rejects incomplete or invalid successful exports", async body => {
      mockApiFetch.mockResolvedValue(new Response(body));
      await expect(AccountService.exportData("owner-token")).rejects.toThrow("did not finish");
    });

    it("cancels a stalled body rather than accepting a partial backup", async () => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      mockApiFetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
      try {
        const operation = AccountService.exportData("owner-token");
        const rejection = expect(operation).rejects.toThrow("did not finish");
        await vi.advanceTimersByTimeAsync(240_000);
        await rejection;
        expect(cancel).toHaveBeenCalledOnce();
      } finally { vi.useRealTimers(); }
    });

    it("preserves a bulk export above the generic small-API limit", async () => {
      const ciphertext = "x".repeat(11 * 1024 * 1024);
      const payload = {
        success: true, requested_target: "account", exported_at: "2026-04-24T00:00:00Z",
        data: { encrypted_pkm_recovery_segments: [{ ciphertext }] },
      };
      mockApiFetch.mockResolvedValue(Response.json(payload));
      const result = await AccountService.exportData("owner-token");
      expect(result.data?.encrypted_pkm_recovery_segments?.[0]?.ciphertext).toBe(ciphertext);
    });

    it("does not expose a refused export body", async () => {
      const cancel = vi.fn();
      mockApiFetch.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 403 }));
      await expect(AccountService.exportData("revoked-token")).rejects.toMatchObject({ status: 403 });
      expect(cancel).toHaveBeenCalledOnce();
    });
  });

  describe("exportBlob", () => {
    const data = {
      actor_profile: null, runtime_persona_state: null, verified_email_aliases: [], encrypted_vault_keys: [],
      encrypted_pkm_manifests: [], encrypted_pkm_index: [], encrypted_pkm_blobs: [],
      encrypted_pkm_recovery_revisions: [{ manifest_snapshot: { entries: ["arbitrary topic"] } }],
      encrypted_pkm_recovery_segments: [{ ciphertext: 'escaped \\"success\\":true and \\u0041' + "x".repeat(16 * 1024) }],
      consent_audit: [{ action: "GRANTED" }],
    };
    const envelope = () => JSON.stringify({ requested_target: "account", exported_at: "2026-04-24T00:00:00Z", data, success: true });
    const blobText = (blob: Blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject; reader.readAsText(blob);
    });
    const streamed = (text: string, cancel = vi.fn(), size = 7) => {
      const bytes = new TextEncoder().encode(text); let offset = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (offset === bytes.length) { controller.close(); return; }
          controller.enqueue(bytes.slice(offset, offset += Math.min(size, bytes.length - offset)));
        }, cancel,
      }));
    };

    it("validates split tokens and preserves all history as raw bytes, excluding only audit", async () => {
      mockApiFetch.mockResolvedValue(streamed(envelope()));
      const parse = JSON.parse;
      const spy = vi.spyOn(JSON, "parse").mockImplementation((value, ...args) => {
        if (String(value).length > 4096) throw new Error("bulk parse forbidden");
        return parse(value, ...args);
      });
      let blob: Blob;
      try { blob = await AccountService.exportBlob("owner-token", { exclude: ["consent_audit"] }); }
      finally { spy.mockRestore(); }
      const { consent_audit: _audit, ...kept } = data;
      expect(JSON.parse(await blobText(blob!))).toEqual(kept);
      expect(mockApiFetch).toHaveBeenCalledWith("/api/account/export", expect.objectContaining({
        headers: { Authorization: "Bearer owner-token" }, cache: "no-store",
      }));
    });

    it.each([
      (s: string) => s.slice(0, -1),
      (s: string) => s + "{}",
      (s: string) => s.replace('"success":true}', '"success":false}'),
      (s: string) => s.replace('"success":true}', '"success":true,"success":true}'),
      (s: string) => s.replace('"actor_profile":null', '"actor_profile":"invalid"'),
      (s: string) => s.replace('"verified_email_aliases":[]', '"verified_email_aliases":[null]'),
      (s: string) => s.replace('"encrypted_pkm_index":[]', '"encrypted_pkm_index":[{},]'),
      (s: string) => s.replace('"runtime_persona_state":null,', ''),
      (s: string) => s.replace('arbitrary topic', 'bad\\x'),
      (s: string) => s.replace('arbitrary topic', 'bad\\u12Q4'),
      (s: string) => s.replace('arbitrary topic', 'bad\u0001'),
      (s: string) => s.replace('"arbitrary topic"', '01'),
      (s: string) => s.replace('"arbitrary topic"', '1e'),
      (s: string) => s.replace('"arbitrary topic"', '+1'),
      (s: string) => s.replace('"consent_audit":[', '"consent_audit":[null,,'),
      (s: string) => s.replace('"actor_profile":null', '"actor_profile":null,"\\u0061ctor_profile":null'),
    ])("rejects malformed, truncated or contradictory envelopes before handoff", async transform => {
      mockApiFetch.mockResolvedValue(streamed(transform(envelope())));
      await expect(AccountService.exportBlob("owner-token")).rejects.toThrow("did not finish");
    });

    it("preserves valid Unicode, nested values and arbitrarily precise raw JSON numbers", async () => {
      const precise = "9".repeat(300);
      const body = envelope().replace('"arbitrary topic"', `{"name":"résumé 🚀", "items":[true,null,-1.25e-3,${precise}]}`);
      mockApiFetch.mockResolvedValue(streamed(body));
      const blob = await AccountService.exportBlob("owner-token");
      expect(await blobText(blob)).toContain(precise);
      expect(await blobText(blob)).toContain("résumé 🚀");
    });

    it.each([new Uint8Array([0xff]), new Uint8Array([0xe2, 0x82])])("rejects malformed UTF-8", async invalid => {
      mockApiFetch.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"requested_target":"'));
        controller.enqueue(invalid); controller.close();
      } })));
      await expect(AccountService.exportBlob("owner-token")).rejects.toThrow("did not finish");
    });

    it("cancels a stalled body within the existing deadline", async () => {
      vi.useFakeTimers(); const cancel = vi.fn();
      mockApiFetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
      try {
        const rejected = expect(AccountService.exportBlob("owner-token")).rejects.toThrow("did not finish");
        await vi.advanceTimersByTimeAsync(240_000); await rejected;
        expect(cancel).toHaveBeenCalledOnce();
      } finally { vi.useRealTimers(); }
    });

    it("cancels upstream when the owner becomes stale while reading", async () => {
      const cancel = vi.fn(); let current = true;
      mockApiFetch.mockResolvedValue(new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new TextEncoder().encode('{"requested_target":')); current = false; }, cancel,
      })));
      await expect(AccountService.exportBlob("owner-token", { requireCurrent() {
        if (!current) throw new DOMException("Expired", "AbortError");
      } })).rejects.toMatchObject({ name: "AbortError" });
      expect(cancel).toHaveBeenCalledOnce();
    });

    it("requires EOF even after a complete-looking footer and handles stream failure", async () => {
      const bytes = new TextEncoder().encode(envelope()); let reads = 0;
      mockApiFetch.mockResolvedValue(new Response(new ReadableStream({ pull(controller) {
        if (reads++ === 0) controller.enqueue(bytes); else controller.error(new Error("lost stream"));
      } })));
      await expect(AccountService.exportBlob("owner-token")).rejects.toThrow("did not finish");
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
