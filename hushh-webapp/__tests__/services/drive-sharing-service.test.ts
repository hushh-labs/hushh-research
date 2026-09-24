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
  validDocumentRequestPeriod,
  validDriveQuery,
} from "@/lib/services/drive-sharing-service";
import {
  documentShareRequestId,
  documentShareSelectionId,
  isDocumentShareSelection,
} from "@/lib/consent/document-share-consent";
import {
  driveQueryRequestId,
  driveSharingSelectionId,
  isDriveQueryEntry,
  isDriveQuerySelection,
  isDriveSharingEntry,
} from "@/lib/consent/drive-query-consent";
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
  it("creates a request with separate Firebase identity and vault authority, without a Drive token", async () => {
    fetcher.mockResolvedValueOnce(
      reply({ requestId, status: "pending", revision: 0 }, 202),
    );
    const draft = {
      ownerPersonRef: documentId,
      clientRequestId: requestId,
      purpose: { purpose: "Statements", periodStart: null, periodEnd: null },
    };
    await expect(
      DriveSharingService.create("vault", "firebase", draft, guard),
    ).resolves.toEqual({ requestId, status: "pending", revision: 0 });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("/api/connectors/google_drive/sharing/requests");
    expect(options).toMatchObject({
      method: "POST",
      cache: "no-store",
      headers: { Authorization: "Bearer firebase", "X-Hushh-Consent": "vault" },
    });
    expect(JSON.parse(options.body)).toEqual(draft);
    expect(options.isEffectCurrent()).toBe(true);
  });
  it.each([
    [null, null, true],
    ["2026-01-01", "2026-06-30", true],
    ["2024-02-29", "2024-02-29", true],
    ["2026-02-29", "2026-03-01", false],
    ["2026-01-01", null, false],
    [null, "2026-06-30", false],
    ["2026-06-30", "2026-01-01", false],
    ["2026-1-1", "2026-06-30", false],
    ["0000-01-01", "2026-06-30", false],
  ])("validates the complete calendar period %s/%s", (start, end, expected) => {
    expect(validDocumentRequestPeriod(start, end)).toBe(expected);
  });
  it("rejects invalid request purposes before dispatch and late creation results after locking", async () => {
    const draft = {
      ownerPersonRef: documentId,
      clientRequestId: requestId,
      purpose: { purpose: " ", periodStart: null, periodEnd: null },
    };
    await expect(
      DriveSharingService.create("vault", "firebase", draft, guard),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fetcher).not.toHaveBeenCalled();
    let current = true;
    fetcher.mockImplementationOnce(async () => {
      current = false;
      return reply({ requestId, status: "pending", revision: 0 });
    });
    await expect(
      DriveSharingService.create(
        "vault",
        "firebase",
        { ...draft, purpose: { ...draft.purpose, purpose: "Statements" } },
        () => {
          if (!current) throw new DriveSharingError("session_changed");
        },
      ),
    ).rejects.toMatchObject({ code: "session_changed" });
  });
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
    await DriveSharingService.approve("owner-token", requestId, review, guard, [documentId]);
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
      DriveSharingService.approve("t", requestId, review, guard, [documentId]),
    ).toThrow(DriveSharingError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([[[]], [["not-reviewed"]], [[documentId, documentId]]])(
    "refuses a selection %j that is empty, repeated or outside the review",
    async (selection) => {
      fetcher.mockResolvedValueOnce(reply(rawReview()));
      const review = await DriveSharingService.review("t", requestId, guard);
      expect(() =>
        DriveSharingService.approve("t", requestId, review, guard, selection),
      ).toThrow(DriveSharingError);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
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

describe("drive question transport", () => {
  const ownerRef = "33333333-3333-4333-8333-333333333333";
  const clientRequestId = "44444444-4444-4444-8444-444444444444";
  const rawView = (overrides: Record<string, unknown> = {}) => ({
    requestId,
    direction: "outgoing",
    status: "pending",
    revision: 1,
    query: "potential bank statement",
    counterpartName: "A",
    createdAt: "2026-09-24T10:00:00Z",
    expiresAt: "2026-10-01T10:00:00Z",
    decidedAt: null,
    answer: null,
    canDecide: false,
    lastError: null,
    ...overrides,
  });
  beforeEach(() => vi.resetAllMocks());

  it("creates a pending question with vault authority only and the exact body", async () => {
    fetcher.mockResolvedValueOnce(reply(rawView(), 202));
    const view = await DriveSharingService.createQuery(
      "vault",
      { ownerPersonRef: ownerRef, clientRequestId, query: "potential bank statement" },
      guard,
    );
    expect(view).toMatchObject({ requestId, direction: "outgoing", status: "pending", answer: null });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("/api/connectors/google_drive/sharing/queries");
    expect(options).toMatchObject({ method: "POST", cache: "no-store" });
    expect(options.headers).toEqual({
      Authorization: "Bearer vault",
      "Content-Type": "application/json",
    });
    expect(options.headers).not.toHaveProperty("X-Hushh-Consent");
    expect(JSON.parse(options.body)).toEqual({
      ownerPersonRef: ownerRef,
      clientRequestId,
      query: "potential bank statement",
    });
    expect(options.isEffectCurrent()).toBe(true);
  });

  it("sends ownerUserId instead of a person ref when that is the only owner", async () => {
    fetcher.mockResolvedValueOnce(reply(rawView(), 202));
    await DriveSharingService.createQuery(
      "vault",
      { ownerUserId: "firebaseUid_123", clientRequestId, query: "Q" },
      guard,
    );
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      ownerUserId: "firebaseUid_123",
      clientRequestId,
      query: "Q",
    });
  });

  it.each([
    ["blank", " \n "],
    ["over 2000 characters", "a".repeat(2001)],
    ["over 2048 UTF-8 bytes", "€".repeat(700)],
  ])("rejects a %s question before dispatch", async (_label, query) => {
    await expect(
      DriveSharingService.createQuery("vault", { ownerPersonRef: ownerRef, clientRequestId, query }, guard),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts exactly 2000 characters and 2048 bytes", () => {
    expect(validDriveQuery("a".repeat(2000))).toBe(true);
    expect(validDriveQuery("€".repeat(682) + "ab")).toBe(true); // 2046 + 2 bytes
    expect(validDriveQuery("€".repeat(683))).toBe(false); // 2049 bytes
  });

  it("requires exactly one well-formed owner and a UUID retry key", async () => {
    for (const draft of [
      { ownerPersonRef: ownerRef, ownerUserId: "uid", clientRequestId, query: "Q" },
      { clientRequestId, query: "Q" },
      { ownerPersonRef: "not-a-uuid", clientRequestId, query: "Q" },
      { ownerPersonRef: ownerRef, clientRequestId: "retry", query: "Q" },
    ]) {
      await expect(
        DriveSharingService.createQuery("vault", draft as never, guard),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows with the revision and the owner's time zone, denies with the revision only", async () => {
    const answered = rawView({
      direction: "incoming",
      status: "answered",
      revision: 3,
      decidedAt: "2026-09-24T10:05:00Z",
      answer: { text: "Found it.", titles: ["March.pdf"], truncated: false },
    });
    fetcher
      .mockResolvedValueOnce(reply(answered))
      .mockResolvedValueOnce(reply({ ...answered, status: "denied", answer: null }));
    const zone = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ timeZone: "Asia/Kolkata" } as Intl.ResolvedDateTimeFormatOptions);
    try {
      await expect(
        DriveSharingService.allowQuery("owner", requestId, 2, guard),
      ).resolves.toMatchObject({ status: "answered", answer: { titles: ["March.pdf"] } });
      await DriveSharingService.denyQuery("owner", requestId, 2, guard);
    } finally {
      zone.mockRestore();
    }
    expect(fetcher.mock.calls[0][0]).toBe(
      `/api/connectors/google_drive/sharing/queries/${requestId}/allow`,
    );
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ revision: 2, timeZone: "Asia/Kolkata" });
    expect(fetcher.mock.calls[1][0]).toBe(
      `/api/connectors/google_drive/sharing/queries/${requestId}/deny`,
    );
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ revision: 2 });
  });

  it("omits a time zone that is not a plain IANA name", async () => {
    fetcher.mockResolvedValueOnce(reply(rawView({ direction: "incoming", status: "running" })));
    const zone = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ timeZone: "Bad Zone;drop" } as Intl.ResolvedDateTimeFormatOptions);
    try {
      await DriveSharingService.allowQuery("owner", requestId, 1, guard);
    } finally {
      zone.mockRestore();
    }
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ revision: 1 });
  });

  it("lists one direction with bounded paging", async () => {
    fetcher.mockResolvedValueOnce(reply({ items: [rawView()], hasMore: true }));
    await expect(
      DriveSharingService.listQueries("vault", "outgoing", guard),
    ).resolves.toMatchObject({ items: [{ requestId }], hasMore: true });
    expect(fetcher.mock.calls[0][0]).toBe(
      "/api/connectors/google_drive/sharing/queries?direction=outgoing&limit=20&offset=0",
    );
    expect(fetcher.mock.calls[0][1].method).toBe("GET");
    fetcher.mockResolvedValueOnce(reply({ items: [rawView()], hasMore: false }));
    await expect(
      DriveSharingService.listQueries("vault", "incoming", guard),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    ["an unknown status", { status: "approved" }],
    ["an unknown direction", { direction: "sideways" }],
    ["an answer before answering", { answer: { text: "x", titles: [], truncated: false } }],
    ["an answered view without an answer", { status: "answered" }],
    ["a non-array title list", { status: "answered", answer: { text: "x", titles: "a.pdf", truncated: false } }],
    ["too many titles", { status: "answered", answer: { text: "x", titles: Array(26).fill("a"), truncated: false } }],
    ["a missing truncation flag", { status: "answered", answer: { text: "x", titles: [] } }],
    ["an unknown last error", { lastError: "provider_secret" }],
    ["a malformed request id", { requestId: "not-a-uuid" }],
    ["an unparseable expiry", { expiresAt: "tomorrow-ish" }],
    ["an overlong question", { query: "q".repeat(2001) }],
  ])("rejects a view with %s", async (_label, overrides) => {
    fetcher.mockResolvedValueOnce(reply(rawView(overrides)));
    await expect(
      DriveSharingService.getQuery("vault", requestId, guard),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("never grants decisions or owner errors to the person who asked", async () => {
    fetcher.mockResolvedValueOnce(
      reply(rawView({ canDecide: true, lastError: "reconnect_required" })),
    );
    await expect(
      DriveSharingService.getQuery("vault", requestId, guard),
    ).resolves.toMatchObject({ canDecide: false, lastError: null });
    fetcher.mockResolvedValueOnce(
      reply(rawView({ direction: "incoming", status: "denied", canDecide: true, decidedAt: "2026-09-24T10:05:00Z" })),
    );
    await expect(
      DriveSharingService.getQuery("vault", requestId, guard),
    ).resolves.toMatchObject({ canDecide: false });
  });

  it("rejects a view for a different question and surfaces only the error code", async () => {
    fetcher.mockResolvedValueOnce(
      reply(rawView({ requestId: "55555555-5555-4555-8555-555555555555" })),
    );
    await expect(
      DriveSharingService.getQuery("vault", requestId, guard),
    ).rejects.toMatchObject({ code: "invalid_response" });
    fetcher.mockResolvedValueOnce(
      reply({ detail: { code: "reconnect_required", message: "private detail" } }, 409),
    );
    await expect(
      DriveSharingService.allowQuery("owner", requestId, 1, guard),
    ).rejects.toMatchObject({ code: "reconnect_required", status: 409 });
  });

  it("recognizes Drive questions separately from document requests", () => {
    const entry = {
      id: `drive_query_request:${requestId}`,
      request_id: requestId,
      action: "DRIVE_QUERY_REVIEW",
      metadata: { request_source: "drive_live_query_request" },
    } as unknown as ConsentCenterEntry;
    expect(isDriveQueryEntry(entry)).toBe(true);
    expect(isDriveSharingEntry(entry)).toBe(true);
    expect(driveSharingSelectionId(entry)).toBe(entry.id);
    expect(driveQueryRequestId(entry.id)).toBe(requestId);
    expect(driveQueryRequestId("drive_query_request:wrong")).toBeNull();
    expect(isDriveQuerySelection("drive_query_request:wrong")).toBe(true);
    expect(documentShareRequestId(entry.id)).toBeNull();
    // A malformed row still fails closed by source or action alone.
    expect(isDriveSharingEntry({ id: "x", action: "DRIVE_QUERY_REVIEW" } as ConsentCenterEntry)).toBe(true);
    expect(isDriveSharingEntry({ id: "x", action: "REQUESTED", metadata: { request_source: "drive_live_query_request" } } as unknown as ConsentCenterEntry)).toBe(true);
    expect(isDriveSharingEntry({ id: "x", action: "REQUESTED" } as ConsentCenterEntry)).toBe(false);
  });
});
