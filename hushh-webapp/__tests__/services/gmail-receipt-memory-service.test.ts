import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: vi.fn(),
  },
}));

import { ApiService } from "@/lib/services/api-service";
import { GmailReceiptMemoryService } from "@/lib/services/gmail-receipt-memory-service";

describe("GmailReceiptMemoryService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to the preview endpoint with force_refresh", async () => {
    vi.spyOn(ApiService, "apiFetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          artifact_id: "artifact-1",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );

    const result = await GmailReceiptMemoryService.preview({
      idToken: "token-1",
      vaultOwnerToken: "vault-token-1",
      userId: "user-1",
      forceRefresh: true,
    });

    expect(result.artifact_id).toBe("artifact-1");
    expect(ApiService.apiFetch).toHaveBeenCalledWith(
      "/api/kai/gmail/receipts-memory/preview",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-1",
          "X-Hushh-Consent": "Bearer vault-token-1",
        }),
        body: JSON.stringify({
          user_id: "user-1",
          force_refresh: true,
        }),
      })
    );
  });

  it("reads a stored artifact by id", async () => {
    vi.spyOn(ApiService, "apiFetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          artifact_id: "artifact-1",
          freshness: { status: "fresh", is_stale: false, stale_after_days: 7, reason: "ok" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );

    const result = await GmailReceiptMemoryService.getArtifact({
      idToken: "token-1",
      vaultOwnerToken: "vault-token-1",
      userId: "user-1",
      artifactId: "artifact-1",
    });

    expect(result.artifact_id).toBe("artifact-1");
    expect(ApiService.apiFetch).toHaveBeenCalledWith(
      "/api/kai/gmail/receipts-memory/artifacts/artifact-1?user_id=user-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer token-1",
          "X-Hushh-Consent": "Bearer vault-token-1",
        }),
      })
    );
  });
});
