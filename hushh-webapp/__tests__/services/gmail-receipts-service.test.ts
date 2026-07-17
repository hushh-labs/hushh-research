import { afterEach, describe, expect, it, vi } from "vitest";

import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import { ApiService } from "@/lib/services/api-service";

vi.mock("@/lib/observability/client", () => ({
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: vi.fn(),
  },
}));

describe("GmailReceiptsService", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends sealed headers when listing receipts", async () => {
    vi.mocked(ApiService.apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          page: 2,
          per_page: 10,
          total: 0,
          has_more: false,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await GmailReceiptsService.listReceipts({
      idToken: "firebase-id-token",
      vaultOwnerToken: "vault-owner-token",
      userId: "user-123",
      page: 2,
      perPage: 10,
    });

    expect(ApiService.apiFetch).toHaveBeenCalledWith(
      "/api/kai/gmail/receipts/user-123?page=2&per_page=10",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer firebase-id-token",
          "X-Hushh-Consent": "Bearer vault-owner-token",
        },
      },
    );
  });
});
