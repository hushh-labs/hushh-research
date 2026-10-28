import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
const stream = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {
  apiFetch: api.fetch, getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
} }));
vi.mock("@/lib/services/native-sse-fetch", () => ({ nativeStreamFetch: stream.fetch }));
import { DriveSearchService, DriveSearchStreamUnavailable, isDriveSearchSelectionReady } from "@/lib/services/drive-search-service";
const jobId = "11111111-1111-4111-8111-111111111111";
const status = { jobId, status: "running", revision: 1, matched: 1, pagesScanned: 1,
  incompleteSearch: false, canStop: true, createdAt: "2026-09-27T00:00:00Z",
  expiresAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-27T00:00:02Z", errorCode: null };
const page = { jobId, revision: 1, matched: 1, nextCursor: "opaque+/=",
  files: [{ position: 1, id: "file-one", name: "Explain For Product", mimeType: "application/vnd.google-apps.document",
    modifiedTime: null, openUrl: "https://docs.google.com/document/d/file-one/edit" }] };
beforeEach(() => { vi.resetAllMocks(); });
describe("owner Drive search API boundary", () => {
  it("retains the deployed provider-query coverage and its real file-page count", async () => {
    const coverage = { corpora: ["user", "member_shared_drives"], fileKind: "any",
      requestedPeriod: { start: "2026-06-02", end: "2026-10-02", timezone: "Asia/Calcutta" },
      dateBasis: "provider_query", datePushdown: "not_expressed", timeIntent: "file_activity",
      ownerReviewRequired: false, contentPeriodVerified: false, providerRowsScanned: 25,
      providerFilePages: 8, excludedByDateCount: 0, deduplicatedCount: 0,
      unavailableShortcutCount: 0, providerPagesExhausted: true, shareabilityVerified: true };
    api.fetch.mockResolvedValueOnce(Response.json({ ...status, status: "completed", matched: 25, unshareableCount: 13, coverage }));
    expect((await DriveSearchService.get("owner", jobId, () => undefined)).coverage).toEqual(coverage);
    api.fetch.mockResolvedValueOnce(Response.json({ ...status, coverage: { ...coverage, datePushdown: "private-unrecognized-value" } }));
    await expect(DriveSearchService.get("owner", jobId, () => undefined)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("retains unverified document periods for owner review and rejects automatic coverage claims", async () => {
    const coverage = { corpora: ["user"], fileKind: "document",
      requestedPeriod: { start: "2026-01-01", end: "2026-06-30", timezone: "Asia/Kolkata" },
      dateBasis: "content_period_unverified", timeIntent: "document_coverage",
      ownerReviewRequired: true, contentPeriodVerified: false,
      providerRowsScanned: 1035, excludedByDateCount: 0, deduplicatedCount: 789,
      unavailableShortcutCount: 0, providerPagesExhausted: true, shareabilityVerified: true };
    api.fetch.mockResolvedValueOnce(Response.json({ ...status, status: "completed", matched: 46, coverage }));
    const parsed = await DriveSearchService.get("owner", jobId, () => undefined);
    expect(parsed.coverage).toEqual(coverage);
    expect(isDriveSearchSelectionReady(parsed)).toBe(true);
    for (const change of [
      { ownerReviewRequired: false }, { ownerReviewRequired: "true" },
      { ownerReviewRequired: undefined }, { timeIntent: undefined },
      { timeIntent: "file_activity" }, { timeIntent: "unknown" },
      { contentPeriodVerified: true }, { dateBasis: "verified_content" },
    ]) {
      api.fetch.mockResolvedValueOnce(Response.json({ ...status, coverage: { ...coverage, ...change } }));
      await expect(DriveSearchService.get("owner", jobId, () => undefined)).rejects.toMatchObject({ code: "invalid_response" });
    }
    const legacy = { ...coverage, dateBasis: "title_date_then_created_or_modified", timeIntent: undefined };
    api.fetch.mockResolvedValueOnce(Response.json({ ...status, coverage: legacy }));
    expect((await DriveSearchService.get("owner", jobId, () => undefined)).coverage)
      .toMatchObject({ ownerReviewRequired: true, dateBasis: "title_date_then_created_or_modified" });
  });
  it("accepts the autoshare coverage every new Trusted or allowed search sends", async () => {
    // Exactly what create_for_request(autoshare=True) freezes and the owner
    // search status serves: document coverage with no owner file review.
    const coverage = { corpora: ["user", "member_shared_drives"], fileKind: "document",
      requestedPeriod: { start: "2026-09-02", end: "2026-10-02", timezone: "Asia/Kolkata" },
      dateBasis: "title_date_then_created_then_modified", timeIntent: "document_coverage",
      ownerReviewRequired: false, contentPeriodVerified: false,
      providerRowsScanned: 262, excludedByDateCount: 4, deduplicatedCount: 0,
      unavailableShortcutCount: 0, providerPagesExhausted: false, shareabilityVerified: true };
    api.fetch.mockResolvedValueOnce(Response.json({ ...status, coverage }));
    expect((await DriveSearchService.get("owner", jobId, () => undefined)).coverage).toEqual(coverage);
    // The autoshare basis never claims owner review, and no other basis skips it.
    for (const change of [
      { ownerReviewRequired: true }, { ownerReviewRequired: undefined },
      { dateBasis: "title_date_then_created_or_modified" },
      { dateBasis: "content_period_unverified" },
    ]) {
      api.fetch.mockResolvedValueOnce(Response.json({ ...status, coverage: { ...coverage, ...change } }));
      await expect(DriveSearchService.get("owner", jobId, () => undefined)).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
  it("preserves finalized top-N coverage and rejects partial or inconsistent selection claims", async () => {
    const coverage = { corpora: ["user", "member_shared_drives"], fileKind: "document",
      requestedPeriod: null, dateBasis: "title_date_then_created_or_modified", contentPeriodVerified: false,
      providerRowsScanned: 250, excludedByDateCount: 0, deduplicatedCount: 0,
      unavailableShortcutCount: 0, providerPagesExhausted: false, shareabilityVerified: true,
      requestedResultLimit: 100, resultOrder: "modifiedTime desc", selectionFinalized: true,
      candidateCount: 125, candidateCountScope: "retained_pool", candidatePoolPruned: true };
    const complete = { ...status, status: "completed", matched: 100, coverage };
    api.fetch.mockResolvedValueOnce(Response.json(complete));
    const parsed = await DriveSearchService.get("owner", jobId, () => undefined);
    expect(parsed.coverage).toEqual(coverage);
    expect(isDriveSearchSelectionReady(parsed)).toBe(true);
    for (const value of [
      { ...complete, status: "running" },
      { ...complete, incompleteSearch: true },
      { ...complete, matched: 101 },
      { ...complete, coverage: { ...coverage, requestedResultLimit: undefined } },
      { ...complete, coverage: { ...coverage, requestedResultLimit: 1001 } },
      { ...complete, coverage: { ...coverage, resultOrder: "name asc" } },
      { ...complete, coverage: { ...coverage, selectionFinalized: "true" } },
      { ...complete, coverage: { ...coverage, selectionFinalized: false } },
      { ...complete, coverage: { ...coverage, candidateCount: 99 } },
      { ...complete, coverage: { ...coverage, candidatePoolPruned: false } },
    ]) {
      api.fetch.mockResolvedValueOnce(Response.json(value));
      await expect(DriveSearchService.get("owner", jobId, () => undefined)).rejects.toMatchObject({ code: "invalid_response" });
    }
    api.fetch.mockResolvedValueOnce(Response.json({ ...status, matched: 0,
      coverage: { ...coverage, selectionFinalized: false } }));
    expect(isDriveSearchSelectionReady(await DriveSearchService.get("owner", jobId, () => undefined))).toBe(false);
  });
  it("preserves search scope and metadata-date coverage without claiming content verification", async () => {
    const coverage = { corpora: ["user", "member_shared_drives"], fileKind: "document",
      requestedPeriod: { start: "2026-06-28", end: "2026-09-28", timezone: "Asia/Kolkata" },
      dateBasis: "title_date_then_created_or_modified", contentPeriodVerified: false,
      providerRowsScanned: 540, excludedByDateCount: 450, excludedByTopicCount: 7, deduplicatedCount: 18,
      unavailableShortcutCount: 0, providerPagesExhausted: true, shareabilityVerified: true };
    api.fetch.mockResolvedValueOnce(Response.json({ ...status, status: "completed", coverage }));
    expect((await DriveSearchService.get("owner", jobId, () => undefined)).coverage).toEqual(coverage);
    api.fetch.mockResolvedValueOnce(Response.json({ ...status, coverage: { ...coverage, corpora: ["private_raw_error"] } }));
    await expect(DriveSearchService.get("owner", jobId, () => undefined)).rejects.toMatchObject({ code: "invalid_response" });
    api.fetch.mockResolvedValueOnce(Response.json({ ...status, coverage: { ...coverage, excludedByTopicCount: -1 } }));
    await expect(DriveSearchService.get("owner", jobId, () => undefined)).rejects.toMatchObject({ code: "invalid_response" });
    api.fetch.mockResolvedValueOnce(Response.json({ ...status, coverage: { ...coverage, shareabilityVerified: "true" } }));
    await expect(DriveSearchService.get("owner", jobId, () => undefined)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("sends explicit search-only consent, preserving literal query and opaque pagination", async () => {
    api.fetch.mockResolvedValueOnce(Response.json(status));
    await DriveSearchService.create("owner", "Find L'été \\ notes", jobId, () => undefined);
    const [path, options] = api.fetch.mock.calls[0];
    expect(path).toBe("/api/connectors/google_drive/searches");
    expect(options.cache).toBe("no-store");
    expect(JSON.parse(options.body)).toEqual({ clientRequestId: jobId, query: "Find L'été \\ notes", backgroundConsent: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    api.fetch.mockResolvedValueOnce(Response.json(page));
    await expect(DriveSearchService.results("owner", jobId, () => undefined, "opaque+/=")).resolves.toMatchObject(page);
    expect(api.fetch.mock.calls[1][0]).toBe(`/api/connectors/google_drive/searches/${jobId}/results?cursor=opaque%2B%2F%3D`);
    for (const reason of ["source_not_shareable", "shareability_unverified"] as const) {
      api.fetch.mockResolvedValueOnce(Response.json({ ...page, files: [{ ...page.files[0],
        shareable: false, unavailableReason: reason }] }));
      expect((await DriveSearchService.results("owner", jobId, () => undefined)).files[0])
        .toMatchObject({ shareable: false, unavailableReason: reason });
    }
  });
  it("fails closed for another job, unsafe URLs, duplicate files and overlarge result pages", async () => {
    for (const value of [
      { ...page, jobId: "22222222-2222-4222-8222-222222222222" },
      { ...page, files: [{ ...page.files[0], openUrl: "https://evil.invalid/drive" }] },
      { ...page, files: [{ ...page.files[0], openUrl: "javascript:alert(1)" }] },
      { ...page, files: [{ ...page.files[0], shareable: false, unavailableReason: "private_provider_reason" }] },
      { ...page, files: [page.files[0], page.files[0]] },
      { ...page, files: [{ ...page.files[0], position: 0 }] },
      { ...page, files: [{ ...page.files[0], position: 10_001 }] },
      { ...page, files: Array.from({ length: 26 }, (_, index) => ({ ...page.files[0], id: String(index) })) },
    ]) {
      api.fetch.mockResolvedValueOnce(Response.json(value));
      await expect(DriveSearchService.results("owner", jobId, () => undefined)).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
  it("rechecks owner authority after response decoding and never publishes provider messages", async () => {
    let current = true;
    const guard = () => { if (!current) throw new Error("session_changed"); };
    api.fetch.mockResolvedValueOnce({ ok: true, text: async () => { current = false; return JSON.stringify(page); } });
    await expect(DriveSearchService.results("owner", jobId, guard)).rejects.toThrow("session_changed");
    api.fetch.mockResolvedValueOnce(Response.json({ detail: { code: "search_unavailable", message: "PRIVATE PROVIDER TEXT" } }, { status: 503 }));
    await expect(DriveSearchService.get("owner", jobId, () => undefined)).rejects.toMatchObject({
      code: "search_unavailable", message: "Drive search could not finish.",
    });
  });
});

describe("owner Drive search progress stream", () => {
  const frame = (event: string, payload: object) =>
    `event: ${event}\ndata: ${JSON.stringify({ event, ...payload })}\n\n`;
  const response = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });

  it("uses the owner bearer and refreshes only increasing status revisions", async () => {
    const body = frame("status", status) + frame("heartbeat", {}) +
      frame("status", status) +
      frame("status", { ...status, revision: 2, matched: 2, status: "completed" });
    stream.fetch.mockResolvedValueOnce(response([body.slice(0, 17), body.slice(17)]));
    const onStatus = vi.fn();
    await expect(DriveSearchService.streamStatus("owner", jobId, () => undefined, onStatus))
      .resolves.toBe("complete");
    expect(onStatus.mock.calls.map(([value]) => [value.revision, value.matched]))
      .toEqual([[1, 1], [2, 2]]);
    expect(stream.fetch).toHaveBeenCalledWith(
      `/api/connectors/google_drive/searches/${jobId}/stream`,
      expect.objectContaining({ method: "GET", cache: "no-store",
        headers: { Authorization: "Bearer owner", Accept: "text/event-stream" } }),
    );
  });

  it("continues a completed V1 search stream through content evaluation", async () => {
    const pending = { ...status, status: "completed", revision: 2, matched: 2,
      evaluation: { status: "running", evaluatedCount: 1, pendingCount: 1, verifiedCount: 1 } };
    const ready = { ...pending, revision: 3,
      evaluation: { status: "ready", evaluatedCount: 2, pendingCount: 0, verifiedCount: 1 } };
    stream.fetch.mockResolvedValueOnce(response([frame("status", pending) + frame("status", ready)]));
    const onStatus = vi.fn();
    await expect(DriveSearchService.streamStatus("owner", jobId, () => undefined, onStatus))
      .resolves.toBe("complete");
    expect(onStatus.mock.calls.map(([value]) => value.evaluation?.status))
      .toEqual(["running", "ready"]);
    for (const bad of [
      { ...pending, evaluation: { ...pending.evaluation, status: "pretend_ready" } },
      { ...pending, evaluation: { ...pending.evaluation, pendingCount: 2 } },
      { ...pending, evaluation: { ...pending.evaluation, verifiedCount: 2 } },
    ]) {
      api.fetch.mockResolvedValueOnce(Response.json(bad));
      await expect(DriveSearchService.get("owner", jobId, () => undefined))
        .rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("falls back to durable polling when streaming is unsupported or interrupted", async () => {
    stream.fetch.mockResolvedValueOnce(Response.json({ detail: "Not Found" }, { status: 404 }));
    await expect(DriveSearchService.streamStatus("owner", jobId, () => undefined, vi.fn()))
      .rejects.toBeInstanceOf(DriveSearchStreamUnavailable);
    stream.fetch.mockResolvedValueOnce(Response.json({ status: "running" }));
    await expect(DriveSearchService.streamStatus("owner", jobId, () => undefined, vi.fn()))
      .rejects.toBeInstanceOf(DriveSearchStreamUnavailable);
    stream.fetch.mockResolvedValueOnce(response([frame("status", status)]));
    await expect(DriveSearchService.streamStatus("owner", jobId, () => undefined, vi.fn()))
      .resolves.toBe("interrupted");
  });

  it("rejects mismatched or malformed progress without rendering it", async () => {
    for (const body of [
      frame("status", { ...status, jobId: "22222222-2222-4222-8222-222222222222" }),
      frame("status", { ...status, matched: -1 }),
      `event: status\ndata: {bad json}\n\n`,
      `event: status\ndata: ${JSON.stringify({ ...status, event: "file" })}\n\n`,
    ]) {
      stream.fetch.mockResolvedValueOnce(response([body]));
      const onStatus = vi.fn();
      await expect(DriveSearchService.streamStatus("owner", jobId, () => undefined, onStatus))
        .rejects.toMatchObject({ code: "invalid_response" });
      expect(onStatus).not.toHaveBeenCalled();
    }
  });
});

it("@feature_drive_request parses activity union coverage, raw counts and scheduled retries", async () => {
  const coverage = { corpora: ["user"], fileKind: "any",
    requestedPeriod: { start: "2026-06-02", end: "2026-10-02", timezone: "Asia/Kolkata" },
    dateBasis: "activity_union", datePolicy: "drive_activity_union_v1", dateGateApplied: true,
    fallbackActivated: true, contentPeriodVerified: false, providerRowsScanned: 25001,
    providerFilePages: 251, excludedByDateCount: 20000, deduplicatedCount: 0,
    unavailableShortcutCount: 0, providerPagesExhausted: false };
  api.fetch.mockResolvedValueOnce(Response.json({ ...status, matched: 5001, coverage }));
  expect((await DriveSearchService.get("owner", jobId, () => {})).coverage).toEqual(coverage);
  for (const change of [{ datePolicy: undefined }, { dateGateApplied: false }, { fallbackActivated: "true" }, { requestedPeriod: null }, { providerRowsScanned: 1000001 }, { providerFilePages: 1001 }]) {
    api.fetch.mockResolvedValueOnce(Response.json({ ...status, coverage: { ...coverage, ...change } }));
    await expect(DriveSearchService.get("owner", jobId, () => {})).rejects.toMatchObject({ code: "invalid_response" });
  }
  const retry = { status: "queued", nextRetryAt: "2026-09-27T00:05:00Z", retryReason: "provider_unavailable" };
  api.fetch.mockResolvedValueOnce(Response.json({ ...status, ...retry }));
  expect(await DriveSearchService.get("owner", jobId, () => {})).toMatchObject(retry);
  for (const change of [{ nextRetryAt: "private" }, { retryReason: "private" }, { status: "running" }, { retryReason: undefined }]) {
    api.fetch.mockResolvedValueOnce(Response.json({ ...status, ...retry, ...change }));
    await expect(DriveSearchService.get("owner", jobId, () => {})).rejects.toMatchObject({ code: "invalid_response" });
  }
});

it("@feature_drive_request preserves bounded frozen queries only in private diagnostics", async () => {
  const diagnostics = { policy: "drive_activity_union_v1", planVersion: 2,
    planDigest: "a".repeat(64), dateBasis: "activity_union",
    period: { start: "2026-06-02", end: "2026-10-02", timezone: "Asia/Kolkata" },
    fallbackDecision: { armed: true, first_page_valid_distinct_count: 2, futurePrivateKey: "discard-me" },
    queries: [
      { index: 0, role: "primary", query: "name contains 'synthetic'", queryDigest: "b".repeat(64), enabled: true },
      { index: 1, role: "frozen_fallback", query: "fullText contains 'synthetic'", queryDigest: "c".repeat(64), enabled: true },
    ] };
  api.fetch.mockResolvedValueOnce(Response.json({ ...status, diagnostics }));
  const parsed = await DriveSearchService.get("owner", jobId, () => {});
  expect(parsed.diagnostics?.queries).toEqual(diagnostics.queries);
  expect(parsed.diagnostics?.fallbackDecision).toEqual({ armed: true, first_page_valid_distinct_count: 2 });
  for (const change of [
    { queries: [...diagnostics.queries, diagnostics.queries[0]] },
    { queries: [{ ...diagnostics.queries[0], query: "x".repeat(1801) }] },
    { fallbackDecision: { armed: false, first_page_valid_distinct_count: 2 } },
    { planDigest: "untrusted" },
  ]) {
    api.fetch.mockResolvedValueOnce(Response.json({ ...status, diagnostics: { ...diagnostics, ...change } }));
    await expect(DriveSearchService.get("owner", jobId, () => {})).rejects.toMatchObject({ code: "invalid_response" });
  }
  api.fetch.mockResolvedValueOnce(Response.json(status));
  expect((await DriveSearchService.get("owner", jobId, () => {})).diagnostics).toBeUndefined();
});
