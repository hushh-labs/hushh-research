import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: mockApiFetch,
  },
}));

import { ConsentCenterService } from "@/lib/services/consent-center-service";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ConsentCenterService.lookupPendingRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves canonical pending consent requests by request id", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            request_id: "req_email_scope",
            requester_label: "One",
            scope: "attr.travel.preferences.seat.*",
            metadata: {
              request_source: "one_email_kyc_v1",
              connector_public_key: "public-key",
            },
          },
        ],
        missing_request_ids: ["missing_scope"],
      }),
    );

    const result = await ConsentCenterService.lookupPendingRequests({
      vaultOwnerToken: "vault-token",
      userId: "user-1",
      requestIds: ["req_email_scope", " ", "req_email_scope", "missing_scope"],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.scope).toBe("attr.travel.preferences.seat.*");
    expect(result.missing_request_ids).toEqual(["missing_scope"]);
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/consent/pending/lookup?userId=user-1&request_id=req_email_scope&request_id=missing_scope",
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer vault-token",
        },
      }),
    );
  });

  it("does not call the API when no request ids are present", async () => {
    const result = await ConsentCenterService.lookupPendingRequests({
      vaultOwnerToken: "vault-token",
      userId: "user-1",
      requestIds: ["", "  "],
    });

    expect(result).toEqual({ items: [], missing_request_ids: [] });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
