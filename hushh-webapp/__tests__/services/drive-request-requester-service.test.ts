import { beforeEach, describe, expect, it, vi } from "vitest";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: fetcher,
    getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  },
}));
import { DriveRequestRequesterService } from "@/lib/services/drive-request-requester-service";

const requestId = "11111111-1111-4111-8111-111111111111";
const guard = () => {};
const reply = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status });

describe("requester-only document request calls", () => {
  beforeEach(() => vi.resetAllMocks());

  it("previews the caller's own Google account with Firebase and vault authority", async () => {
    fetcher.mockResolvedValueOnce(reply({ email: "b@gmail.test", provider: "google.com" }));
    expect(await DriveRequestRequesterService.recipientIdentity("vault", "firebase", guard))
      .toEqual({ email: "b@gmail.test", provider: "google.com" });
    expect(fetcher.mock.calls[0][0]).toBe("/api/connectors/google_drive/sharing/recipient-identity");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      headers: { Authorization: "Bearer firebase", "X-Hushh-Consent": "vault" },
    });
    for (const payload of [
      { email: "b@gmail.test", provider: "apple.com" },
      { email: "b at gmail", provider: "google.com" },
    ]) {
      fetcher.mockResolvedValueOnce(reply(payload));
      await expect(DriveRequestRequesterService.recipientIdentity("vault", "firebase", guard))
        .rejects.toMatchObject({ code: "invalid_response" });
    }
    fetcher.mockResolvedValueOnce(reply({ detail: { code: "verify_google_identity_required", message: "x" } }, 409));
    await expect(DriveRequestRequesterService.recipientIdentity("vault", "firebase", guard))
      .rejects.toMatchObject({ code: "verify_google_identity_required", status: 409 });
  });

  it("asks for a review with only the vault token and accepts only this request's reply", async () => {
    const answer = {
      requestId,
      reviewRequestedAt: "2026-10-11T08:00:00+00:00",
      ownerRetry: { state: "requested", retryableCount: 1 },
      refund: { state: "none", amountCents: null },
    };
    fetcher.mockResolvedValueOnce(reply(answer));
    expect(await DriveRequestRequesterService.reviewRequest("vault", requestId, guard)).toEqual(answer);
    expect(fetcher.mock.calls[0][0]).toBe(
      `/api/connectors/google_drive/sharing/requests/${requestId}/review-request`,
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "POST", body: "{}", cache: "no-store", headers: { Authorization: "Bearer vault" },
    });
    fetcher.mockResolvedValueOnce(reply({ ...answer, requestId: "22222222-2222-4222-8222-222222222222" }));
    await expect(DriveRequestRequesterService.reviewRequest("vault", requestId, guard))
      .rejects.toMatchObject({ code: "invalid_response" });
    fetcher.mockResolvedValueOnce(reply({ detail: { code: "review_limit_reached", message: "x" } }, 409));
    await expect(DriveRequestRequesterService.reviewRequest("vault", requestId, guard))
      .rejects.toMatchObject({ code: "review_limit_reached" });
    await expect(DriveRequestRequesterService.reviewRequest("vault", "not-a-request", guard))
      .rejects.toMatchObject({ code: "invalid_argument" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
