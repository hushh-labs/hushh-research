import { beforeEach, describe, expect, it, vi } from "vitest";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: fetcher,
    getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  },
}));
import {
  DriveSharingService,
  DriveSharingError,
} from "@/lib/services/drive-sharing-service";
import {
  documentShareRequestId,
  documentShareSelectionId,
  isDocumentShareSelection,
} from "@/lib/consent/document-share-consent";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
const requestId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const guard = () => {};
const rawReview = () => ({
  requestId,
  revision: 3,
  status: "review_ready",
  canApprove: true,
  recipientEmail: "b@example.invalid",
  purpose: {
    purpose: "Statements",
    periodStart: "2026-01-01",
    periodEnd: "2026-06-30",
  },
  files: [{ documentId, name: "<script>untrusted</script>.pdf" }],
  coverage: {
    coverage_summary: "Only January",
    coverage_status: "partial",
    gaps: ["February–June"],
    truncated: true,
  },
  reviewDigest: "a".repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const reply = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status });

describe("private sharing transport", () => {
  beforeEach(() => vi.resetAllMocks());
  it("posts the exact reviewed set, digest and revision without caching", async () => {
    fetcher
      .mockResolvedValueOnce(reply(rawReview()))
      .mockResolvedValueOnce(reply({ status: "approved" }, 202));
    const review = await DriveSharingService.review(
      "owner-token",
      requestId,
      guard,
    );
    expect(review.coverage?.gaps).toEqual(["February–June"]);
    await DriveSharingService.approve("owner-token", requestId, review, guard);
    const [url, options] = fetcher.mock.calls[1];
    expect(url).toBe(
      `/api/connectors/google_drive/sharing/requests/${requestId}/approve`,
    );
    expect(options.cache).toBe("no-store");
    expect(JSON.parse(options.body)).toEqual({
      revision: 3,
      reviewDigest: "a".repeat(64),
      documentIds: [documentId],
      confirmed: true,
    });
    expect(options.isEffectCurrent()).toBe(true);
  });
  it("accepts the API bound of 25 files but rejects 26 or duplicate selections", async () => {
    const files = Array.from({ length: 25 }, (_, i) => ({
      documentId: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
      name: "File",
    }));
    fetcher.mockResolvedValueOnce(reply({ ...rawReview(), files }));
    expect(
      (await DriveSharingService.review("t", requestId, guard)).files,
    ).toHaveLength(25);
    fetcher.mockResolvedValueOnce(
      reply({ ...rawReview(), files: [...files, files[0]] }),
    );
    await expect(
      DriveSharingService.review("t", requestId, guard),
    ).rejects.toMatchObject({ code: "invalid_response" });
    fetcher.mockResolvedValueOnce(
      reply({ ...rawReview(), files: [files[0], files[0]] }),
    );
    await expect(
      DriveSharingService.review("t", requestId, guard),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("refuses expired approval locally without dispatching", async () => {
    fetcher.mockResolvedValueOnce(
      reply({ ...rawReview(), expiresAt: "2020-01-01" }),
    );
    const review = await DriveSharingService.review("t", requestId, guard);
    expect(() =>
      DriveSharingService.approve("t", requestId, review, guard),
    ).toThrow(DriveSharingError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("checks the session again at the actual API dispatch boundary", async () => {
    let current = true;
    fetcher.mockImplementationOnce(async (_url, options) => {
      current = false;
      options.isEffectCurrent();
      return reply({});
    });
    await expect(
      DriveSharingService.decide("t", requestId, "cancel", 1, () => {
        if (!current) throw new DriveSharingError("session_changed");
      }),
    ).rejects.toMatchObject({ code: "session_changed" });
  });
  it.each([
    "https://evil.invalid/file",
    "https://drive.google.com.evil.invalid/file/d/a/view",
    "javascript:alert(1)",
  ])("rejects a noncanonical provider link: %s", async (openUrl) => {
    fetcher.mockResolvedValueOnce(
      reply({
        requestId,
        status: "completed",
        files: [{ name: "File", status: "succeeded", openUrl }],
      }),
    );
    await expect(
      DriveSharingService.delivery("t", requestId, guard),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("does not surface raw provider errors", async () => {
    fetcher.mockResolvedValueOnce(
      reply(
        {
          detail: {
            code: "provider_unavailable",
            message: "secret-token private filename",
          },
        },
        503,
      ),
    );
    await expect(
      DriveSharingService.status("t", requestId, guard),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      message:
        "Could not complete the document request. Refresh and try again.",
    });
  });
  it("does not infer the caller role from a deep link", async () => {
    fetcher.mockResolvedValueOnce(
      reply({ requestId, status: "pending", revision: 1 }),
    );
    await expect(
      DriveSharingService.status("t", requestId, guard),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("preserves a document namespace without allowing malformed links into generic consent", () => {
    const id = `document_share_request:${requestId}`;
    expect(documentShareRequestId(id)).toBe(requestId);
    expect(documentShareRequestId(requestId)).toBeNull();
    expect(isDocumentShareSelection("document_share_request:wrong")).toBe(true);
    expect(documentShareRequestId("document_share_request:wrong")).toBeNull();
    expect(
      documentShareSelectionId({
        id,
        request_id: requestId,
      } as ConsentCenterEntry),
    ).toBe(id);
  });
});
