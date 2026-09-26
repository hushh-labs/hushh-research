import { beforeEach, describe, expect, it, vi } from "vitest";
const fetcher = vi.hoisted(() => vi.fn());
const streamer = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/native-sse-fetch", () => ({
  nativeStreamFetch: streamer,
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: fetcher,
    getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  },
}));
import {
  DriveSharingService,
  DriveSharingError,
  StreamUnavailable,
  parseDriveQueryView,
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
  it("keeps a known preparation result and drops anything else", async () => {
    for (const code of [
      "no_relevant_files",
      "no_ready_files",
      "narrow_selection_required",
      "source_changed",
      "preparation_unavailable",
      "trust_revoked",
    ]) {
      fetcher.mockResolvedValueOnce(
        reply({ ...rawReview(), coverage: null, preparationError: code }),
      );
      expect(
        (await DriveSharingService.review("t", requestId, guard))
          .preparationError,
      ).toBe(code);
    }
    for (const value of ["drive_token_raw_error", 7, { code: "x" }, null]) {
      fetcher.mockResolvedValueOnce(
        reply({ ...rawReview(), preparationError: value }),
      );
      expect(
        (await DriveSharingService.review("t", requestId, guard))
          .preparationError,
      ).toBeNull();
    }
    fetcher.mockResolvedValueOnce(reply(rawReview()));
    expect(
      (await DriveSharingService.review("t", requestId, guard))
        .preparationError,
    ).toBeNull();
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

  it("parses a cancelled question and cancels with its revision", async () => {
    const cancelled = rawView({
      status: "cancelled",
      revision: 5,
      decidedAt: "2026-09-24T10:05:00Z",
    });
    expect(parseDriveQueryView(cancelled)).toMatchObject({
      status: "cancelled",
      answer: null,
    });
    fetcher.mockResolvedValueOnce(reply(cancelled));
    await expect(
      DriveSharingService.cancelQuery("vault", requestId, 4, guard),
    ).resolves.toMatchObject({ requestId, status: "cancelled", answer: null });
    expect(fetcher.mock.calls[0][0]).toBe(
      `/api/connectors/google_drive/sharing/queries/${requestId}/cancel`,
    );
    expect(fetcher.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ revision: 4 });
    await expect(
      DriveSharingService.cancelQuery("vault", requestId, -1, guard),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fetcher).toHaveBeenCalledTimes(1);
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
    [
      "the owner's file list in the asker's view",
      {
        direction: "outgoing",
        status: "answered",
        answer: { text: "x", titles: [], truncated: false, files: [{ ref: "f1", name: "a.pdf" }] },
      },
    ],
    [
      "a malformed file reference",
      {
        direction: "incoming",
        status: "answered",
        answer: { text: "x", titles: [], truncated: false, files: [{ ref: "x9", name: "a.pdf" }] },
      },
    ],
    [
      "a malformed share id",
      { status: "answered", answer: { text: "x", titles: [], truncated: false, shareRequestId: "nope" } },
    ],
  ])("rejects a view with %s", async (_label, overrides) => {
    fetcher.mockResolvedValueOnce(reply(rawView(overrides)));
    await expect(
      DriveSharingService.getQuery("vault", requestId, guard),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("shares only a valid, non-empty selection of answer files", async () => {
    for (const refs of [[], ["f0"], ["f1", "f1"], ["f11"]]) {
      expect(() =>
        DriveSharingService.shareQueryFiles("vault", requestId, refs, guard),
      ).toThrow(DriveSharingError);
    }
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(
      reply(
        rawView({
          direction: "incoming",
          status: "answered",
          answer: { text: "x", titles: [], truncated: false, files: [], shareRequestId: requestId },
        }),
      ),
    );
    await expect(
      DriveSharingService.shareQueryFiles("vault", requestId, ["f1", "f2"], guard),
    ).resolves.toMatchObject({ answer: { shareRequestId: requestId } });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(`/api/connectors/google_drive/sharing/queries/${requestId}/share`);
    expect(JSON.parse(options.body)).toEqual({ fileRefs: ["f1", "f2"] });
  });

  it("restores an owner's reserved answer selection and accepts older answers without one", () => {
    const answer = {
      text: "Found files", titles: [], truncated: false,
      files: [{ ref: "f1", name: "a.pdf" }, { ref: "f2", name: "b.pdf" }],
      shareRequestId: null,
    };
    expect(parseDriveQueryView(rawView({ direction: "incoming", status: "answered", answer })).answer)
      .not.toHaveProperty("selectedFileRefs");
    expect(parseDriveQueryView(rawView({
      direction: "incoming", status: "answered", answer: { ...answer, selectedFileRefs: ["f2"] },
    })).answer).toMatchObject({ selectedFileRefs: ["f2"] });
  });

  it.each([
    ["empty", []], ["duplicate", ["f1", "f1"]], ["not a list", "f1"],
    ["not in the answer", ["f2"]], ["invalid reference", ["f9"]],
    ["not a string", [1]], ["too many", Array(9).fill("f1")],
  ])("rejects an owner's %s reserved answer selection", (_label, selectedFileRefs) => {
    expect(() => parseDriveQueryView(rawView({
      direction: "incoming", status: "answered",
      answer: {
        text: "Found files", titles: [], truncated: false,
        files: [{ ref: "f1", name: "a.pdf" }], selectedFileRefs,
      },
    }))).toThrow(DriveSharingError);
  });

  it("rejects owner reservation references in the asker's answer", () => {
    expect(() => parseDriveQueryView(rawView({
      direction: "outgoing", status: "answered",
      answer: { text: "Found files", titles: [], truncated: false, selectedFileRefs: ["f1"] },
    }))).toThrow(DriveSharingError);
  });

  it("searches the owner's own Drive by person reference and shares only found references", async () => {
    const personRef = "33333333-3333-4333-8333-333333333333";
    const clientRequestId = "44444444-4444-4444-8444-444444444444";
    fetcher.mockResolvedValueOnce(
      reply({
        requestId,
        status: "ready",
        recipientName: "Bo",
        files: [{ ref: "f1", name: "Chris onboarding.mp4", modifiedTime: "2026-09-24T18:00:00Z" }],
        shareRequestId: null,
        expiresAt: "2026-09-25T20:00:00Z",
      }),
    );
    const view = await DriveSharingService.prepareOwnerShare(
      "vault",
      { recipientPersonRef: personRef, clientRequestId, query: "Chris recordings", timeZone: "Asia/Kolkata" },
      guard,
    );
    expect(view).toMatchObject({ status: "ready", recipientName: "Bo", files: [{ ref: "f1" }] });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("/api/connectors/google_drive/sharing/owner-shares");
    expect(JSON.parse(options.body)).toEqual({
      recipientPersonRef: personRef,
      clientRequestId,
      query: "Chris recordings",
      timeZone: "Asia/Kolkata",
    });
    fetcher.mockResolvedValueOnce(
      reply({ requestId, status: "shared", recipientName: "Bo", shareRequestId: documentId,
        files: [{ ref: "f1", name: "Chris onboarding.mp4", modifiedTime: null }] }),
    );
    await expect(
      DriveSharingService.shareOwnerFiles("vault", requestId, ["f1"], guard),
    ).resolves.toMatchObject({ status: "shared", shareRequestId: documentId });
    expect(fetcher.mock.calls[1][0]).toBe(
      `/api/connectors/google_drive/sharing/owner-shares/${requestId}/share`,
    );
    for (const refs of [[], ["f9"], ["f1", "f1"], ["1AbCdEfGhIjKlMnOpQrStUvWxYz012345"]]) {
      await expect(
        DriveSharingService.shareOwnerFiles("vault", requestId, refs, guard),
      ).rejects.toThrow(DriveSharingError);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("restores only valid reserved selections and their terminal expiry", async () => {
    const raw = {
      requestId, status: "ready", recipientName: "Bo", shareRequestId: null,
      files: [{ ref: "f1", name: "Notes", modifiedTime: null }],
      selectedFileRefs: ["f1"], selectionExpired: true,
    };
    fetcher.mockResolvedValueOnce(reply(raw));
    const draft = { recipientPersonRef: requestId, clientRequestId: documentId, query: "Notes" };
    await expect(DriveSharingService.prepareOwnerShare("vault", draft, guard))
      .resolves.toMatchObject({ selectedFileRefs: ["f1"], selectionExpired: true });
    for (const invalid of [
      { selectedFileRefs: [] }, { selectedFileRefs: ["f2"] },
      { selectedFileRefs: ["f1", "f1"] }, { selectedFileRefs: null },
      { selectionExpired: "true" },
    ]) {
      fetcher.mockResolvedValueOnce(reply({ ...raw, ...invalid }));
      await expect(DriveSharingService.prepareOwnerShare("vault", draft, guard))
        .rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("keeps a no-match search empty and refuses a found file carrying a Drive id", async () => {
    fetcher.mockResolvedValueOnce(
      reply({ requestId: null, status: "no_match", files: [], message: "Which file do you mean?" }),
    );
    await expect(
      DriveSharingService.prepareOwnerShare(
        "vault",
        { recipientPersonRef: requestId, clientRequestId: documentId, query: "x" },
        guard,
      ),
    ).resolves.toEqual({
      requestId: null,
      status: "no_match",
      recipientName: null,
      files: [],
      shareRequestId: null,
      message: "Which file do you mean?",
    });
    fetcher.mockResolvedValueOnce(
      reply({ requestId, status: "ready", files: [{ ref: "fileid", name: "x", modifiedTime: null }] }),
    );
    await expect(
      DriveSharingService.prepareOwnerShare(
        "vault",
        { recipientPersonRef: requestId, clientRequestId: documentId, query: "x" },
        guard,
      ),
    ).rejects.toThrow(DriveSharingError);
  });

  it("searches for the Trusted circle and parses who can and cannot receive", async () => {
    const clientRequestId = "44444444-4444-4444-8444-444444444444";
    fetcher.mockResolvedValueOnce(
      reply({
        status: "ready",
        files: [{ ref: "f1", name: "Chris onboarding.mp4", modifiedTime: null }],
        recipients: [{ requestId, name: "Bo", status: "ready", shareRequestId: null }],
        excluded: [{ name: "Cy", reason: "contacts" }, { name: null, reason: "not_connected" }],
        message: null,
      }),
    );
    const view = await DriveSharingService.prepareTrustedShare(
      "vault",
      { clientRequestId, query: "Chris recordings" },
      guard,
    );
    expect(view.recipients).toEqual([
      { requestId, name: "Bo", status: "ready", shareRequestId: null, selectedFileRefs: null, selectionExpired: false },
    ]);
    expect(view.excluded.map((item) => item.reason)).toEqual(["contacts", "not_connected"]);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      audience: "trusted_circle",
      clientRequestId,
      query: "Chris recordings",
    });
    fetcher.mockResolvedValueOnce(
      reply({ status: "ready", files: [], recipients: [], excluded: [{ name: "x", reason: "because" }] }),
    );
    await expect(
      DriveSharingService.prepareTrustedShare("vault", { clientRequestId, query: "x" }, guard),
    ).rejects.toThrow(DriveSharingError);
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

describe("streamed preparation", () => {
  beforeEach(() => vi.resetAllMocks());
  const encoder = new TextEncoder();
  const frame = (event: string, payload: Record<string, unknown> = {}) =>
    `event: ${event}\ndata: ${JSON.stringify({ event, ...payload })}\n\n`;
  const streamOf = (chunks: string[], { hang = false } = {}) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (!hang) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return {
      response: new Response(body, {
        headers: { "content-type": "text/event-stream" },
      }),
      cancelled: () => cancelled,
    };
  };
  const run = (
    onStage = vi.fn(),
    signal?: AbortSignal,
    check = guard,
  ) =>
    DriveSharingService.prepareStream("owner-a", requestId, check, {
      onStage,
      signal,
    });

  it("reports stages in order and returns the committed status", async () => {
    const whole =
      frame("stage", { stage: "starting" }) +
      frame("heartbeat") +
      frame("stage", { stage: "searching" }) +
      frame("stage", { stage: "checking" }) +
      frame("stage", { stage: "choosing" }) +
      frame("complete", { status: "review_ready" });
    // Frames split mid-line across reads are reassembled.
    const chunks = [whole.slice(0, 17), whole.slice(17, 90), whole.slice(90)];
    streamer.mockResolvedValueOnce(streamOf(chunks).response);
    const onStage = vi.fn();
    await expect(run(onStage)).resolves.toBe("review_ready");
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([
      "starting",
      "searching",
      "checking",
    ]);
    const [path, init] = streamer.mock.calls[0];
    expect(path).toBe(
      `/api/connectors/google_drive/sharing/requests/${requestId}/prepare/stream`,
    );
    expect(init).toMatchObject({ method: "POST", cache: "no-store", body: "{}" });
    expect(init.headers).toMatchObject({
      Authorization: "Bearer owner-a",
      Accept: "text/event-stream",
    });
  });

  it("rejects an unknown stage, an unknown status and oversized frames", async () => {
    for (const body of [
      frame("stage", { stage: "reading-private-file.pdf" }),
      frame("complete", { status: "shared" }),
      frame("stage", { stage: "starting", pad: "x".repeat(2000) }),
      `event: stage\ndata: {"event":"complete","status":"review_ready"}\n\n`,
    ]) {
      streamer.mockResolvedValueOnce(streamOf([body]).response);
      await expect(run()).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("surfaces only an allowlisted server code and never a client-internal one", async () => {
    streamer.mockResolvedValueOnce(
      streamOf([
        frame("error", { code: "reconnect_required", message: "<b>provider</b>" }),
      ]).response,
    );
    const error = await run().catch((cause) => cause);
    expect(error).toBeInstanceOf(DriveSharingError);
    expect(error.code).toBe("reconnect_required");
    expect(error.message).not.toContain("provider");
    for (const code of ["session_changed", "request_failed", "made_up"]) {
      streamer.mockResolvedValueOnce(
        streamOf([frame("error", { code, message: "x" })]).response,
      );
      await expect(run()).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("treats a stream that ends or breaks without a result as interrupted", async () => {
    streamer.mockResolvedValueOnce(
      streamOf([frame("stage", { stage: "starting" })]).response,
    );
    await expect(run()).resolves.toBe("interrupted");
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("network"));
      },
    });
    streamer.mockResolvedValueOnce(
      new Response(broken, { headers: { "content-type": "text/event-stream" } }),
    );
    await expect(run()).resolves.toBe("interrupted");
  });

  it("asks for the POST fallback only when this route cannot stream", async () => {
    streamer.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }),
    );
    await expect(run()).rejects.toBeInstanceOf(StreamUnavailable);
    streamer.mockResolvedValueOnce(Response.json({ status: "review_ready" }));
    await expect(run()).rejects.toBeInstanceOf(StreamUnavailable);
    streamer.mockRejectedValueOnce(
      Object.assign(new Error("not implemented"), { code: "UNIMPLEMENTED" }),
    );
    await expect(run()).rejects.toBeInstanceOf(StreamUnavailable);
    // A busy stream route defers to the plain POST.
    streamer.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          detail: { code: "sharing_unavailable", message: "x" },
        }),
        { status: 503 },
      ),
    );
    await expect(run()).rejects.toBeInstanceOf(StreamUnavailable);
    // A coded refusal is a real error, not a missing route.
    streamer.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          detail: { code: "request_unavailable", message: "x" },
        }),
        { status: 404 },
      ),
    );
    await expect(run()).rejects.toMatchObject({
      code: "request_unavailable",
      status: 404,
    });
    streamer.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Owner authorization required" }), {
        status: 401,
      }),
    );
    await expect(run()).rejects.toMatchObject({ code: "request_failed", status: 401 });
  });

  it("stops reading and cancels the stream once the session changes or the run is aborted", async () => {
    const stream = streamOf([frame("stage", { stage: "starting" })], { hang: true });
    streamer.mockResolvedValueOnce(stream.response);
    let current = true;
    const onStage = vi.fn(() => {
      current = false;
    });
    const check = () => {
      if (!current) throw new DriveSharingError("session_changed");
    };
    const controller = new AbortController();
    const pending = run(onStage, controller.signal, check);
    await vi.waitFor(() => expect(onStage).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "session_changed" });
    expect(stream.cancelled()).toBe(true);
    expect(onStage).toHaveBeenCalledTimes(1);
  });
});
