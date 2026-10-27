import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));
vi.mock("@/lib/kai/kai-financial-resource", () => ({
  KaiFinancialResourceService: { invalidate: vi.fn() },
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: { invalidateDomain: vi.fn() },
}));
vi.mock("@/lib/kai/kai-market-home-resource", () => ({
  KaiMarketHomeResourceService: { invalidateUser: vi.fn() },
}));
vi.mock("@/lib/kai/kai-market-news-resource", () => ({
  KaiMarketNewsResourceService: { invalidateUser: vi.fn() },
}));
vi.mock("@/lib/services/unlock-warm-orchestrator", () => ({
  UnlockWarmOrchestrator: { invalidateForUser: vi.fn() },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: vi.fn() },
}));

import { CacheService } from "@/lib/services/cache-service";
import { currentFeedInvalidationEpoch } from "@/lib/cache/feed-invalidation-epoch";
import { ApiService } from "@/lib/services/api-service";
import { OneCopyPresentationService } from "@/lib/services/one-copy-presentation-service";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { OneCopyService } from "@/lib/services/one-copy-service";
import { DocumentHostingService } from "@/lib/services/document-hosting-service";

describe("hosted document transport and consent projection boundaries", () => {
  const userId = "document-owner";
  let spyInvalidate: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    const cache = CacheService.getInstance(); cache.clear();
    spyInvalidate = vi.spyOn(cache, "invalidate");
  });
  afterEach(() => { CacheService.getInstance().clear(); vi.restoreAllMocks(); });
  it("hosted document authority mutations invalidate the current owner's projections, while reads, ciphertext transport and activity do not", async () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    const session = { userId, vaultKey: "vault", vaultOwnerToken: "owner", isCurrent: () => true };
    vi.mocked(ApiService.apiFetch).mockImplementation(async () => new Response(JSON.stringify({ uploadId: "upload" }), { status: 200 }));
    for (const mutate of [
      () => DocumentHostingService.create(session, {}),
      () => DocumentHostingService.approve(session, requestId, { phase: "prepare" }),
      () => DocumentHostingService.approve(session, requestId, { phase: "final" }),
      () => DocumentHostingService.stagePackage(session, requestId, {}),
      () => DocumentHostingService.recoveryAmendment(session, requestId, {}),
      () => DocumentHostingService.revoke(session, requestId, 1, "both"),
    ]) {
      const before = currentFeedInvalidationEpoch(userId);
      await mutate();
      expect(currentFeedInvalidationEpoch(userId)).not.toBe(before);
    }
    const settled = currentFeedInvalidationEpoch(userId);
    const invalidations = spyInvalidate.mock.calls.length;
    await DocumentHostingService.terms(session, requestId);
    await DocumentHostingService.sourceSelection(session, requestId);
    expect(vi.mocked(ApiService.apiFetch).mock.calls.at(-1)![0]).toBe(`/api/connectors/google_drive/sharing/requests/${requestId}/delivery/source-selection`);
    await DocumentHostingService.sourceSession(session, requestId, 1);
    await DocumentHostingService.challenge(session, requestId, { phase: "issue" });
    await DocumentHostingService.upload(session, requestId, 1, { artifactId: requestId, fileRef: null, role: "manifest", iv: "iv", plaintextBytes: 1, ciphertextBytes: 17, ciphertextSha256: "a".repeat(64) }, new Uint8Array(17));
    await DocumentHostingService.activity(session, requestId, { interactionId: "interaction", artifactId: requestId, eventId: "event", kind: "preview_rendered", outcome: "success" });
    expect(currentFeedInvalidationEpoch(userId)).toBe(settled);
    expect(spyInvalidate).toHaveBeenCalledTimes(invalidations);
  });

  it("uses the activity sequence cursor for bounded pages and rejects a repeated or malformed continuation", async () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    const session = { userId, vaultKey: "vault", vaultOwnerToken: "owner", isCurrent: () => true };
    const event = (sequence: number) => ({ sequence, kind: "preview_rendered", interactionId: `visit-${sequence}`, createdAt: "2026-10-25T00:00:00Z" });
    vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ items: Array.from({ length: 50 }, (_, index) => event(51 + index)), nextCursor: "100" })));
    expect((await DocumentHostingService.timeline(session, requestId, undefined, "50")).items).toHaveLength(50);
    expect(vi.mocked(ApiService.apiFetch).mock.calls.at(-1)![0]).toBe(`/api/connectors/google_drive/sharing/requests/${requestId}/delivery/activity?cursor=50`);
    vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ items: [event(101)], nextCursor: null })));
    expect((await DocumentHostingService.timeline(session, requestId, undefined, "100")).items[0]!.sequence).toBe(101);
    vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ items: [event(100)], nextCursor: null })));
    await expect(DocumentHostingService.timeline(session, requestId, undefined, "100")).rejects.toThrow("document_activity_invalid");
    const calls = vi.mocked(ApiService.apiFetch).mock.calls.length;
    await expect(DocumentHostingService.timeline(session, requestId, undefined, "100&other=owner")).rejects.toThrow("document_activity_cursor_invalid");
    expect(ApiService.apiFetch).toHaveBeenCalledTimes(calls);
  });

  it("does not invalidate after a failed hosted mutation or a late response from an ended session", async () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    let current = true;
    const session = { userId, vaultKey: "vault", vaultOwnerToken: "owner", isCurrent: () => current };
    const before = currentFeedInvalidationEpoch(userId);
    vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ detail: { code: "denied" } }), { status: 403 }));
    await expect(DocumentHostingService.approve(session, requestId, { phase: "prepare" })).rejects.toThrow("denied");
    expect(currentFeedInvalidationEpoch(userId)).toBe(before);
    vi.mocked(ApiService.apiFetch).mockImplementationOnce(async () => { current = false; return new Response("{}", { status: 200 }); });
    await expect(DocumentHostingService.revoke(session, requestId, 1, "one")).rejects.toMatchObject({ name: "AbortError" });
    expect(currentFeedInvalidationEpoch(userId)).toBe(before);
    expect(spyInvalidate).not.toHaveBeenCalled();
  });

});

describe("background One-copy authenticated transport", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const fileRef = "22222222-2222-4222-8222-222222222222";
  it("uses the current owner token and exact content disposition without provider URLs", async () => {
    const session = { userId: "b", vaultKey: "vault", vaultOwnerToken: "HCT:synthetic", isCurrent: () => true };
    vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    expect(await OneCopyService.content(session, requestId, fileRef, "download", new AbortController().signal)).toEqual(new Uint8Array([1, 2, 3]));
    expect(ApiService.apiFetch).toHaveBeenLastCalledWith(`/api/connectors/google_drive/sharing/requests/${requestId}/one-copy/files/${fileRef}/content?disposition=download`, expect.objectContaining({ cache: "no-store", responseType: "arraybuffer", headers: { Authorization: "Bearer HCT:synthetic" } }));
  });
  it.each(["timeout", "abort", "session"])("cancels a hanging original body on %s and erases received chunks", async reason => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController(); let current = true; const chunk = new Uint8Array([1, 2, 3]);
      const cancel = vi.fn();
      const body = new ReadableStream({ start(stream) { stream.enqueue(chunk); }, cancel });
      const session = { userId: "b", vaultKey: "synthetic", vaultOwnerToken: "synthetic", isCurrent: () => current };
      vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(new Response(body));
      const pending = OneCopyService.content(session, requestId, fileRef, "download", controller.signal);
      const rejected = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      if (reason === "abort") controller.abort();
      if (reason === "session") current = false;
      await vi.advanceTimersByTimeAsync(reason === "timeout" ? 60_001 : 1000);
      await rejected; expect(cancel).toHaveBeenCalled(); expect(chunk).toEqual(new Uint8Array(3));
    } finally { vi.useRealTimers(); }
  });
  it("erases late transferred original bytes if the session changes", async () => {
    let current = true; const bytes = new Uint8Array([4, 5]);
    const session = { userId: "b", vaultKey: "vault", vaultOwnerToken: "HCT:synthetic", isCurrent: () => current };
    const body = new ReadableStream({ pull(controller) { current = false; controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 });
    vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(new Response(body));
    await expect(OneCopyService.content(session, requestId, fileRef, "preview", new AbortController().signal)).rejects.toThrow();
    expect(bytes).toEqual(new Uint8Array(2));
  });
});


describe("One-copy presentation cache is never access authority", () => {
  it("shares reads, retains warm metadata, bounds forced followups, and drops the retired vault generation", async () => {
    CacheService.getInstance().clear();
    const requestId = "11111111-1111-4111-8111-111111111111";
    const session = { userId: "owner", vaultKey: "synthetic", vaultOwnerToken: "synthetic", isCurrent: () => true };
    const value = { requestId, actorRole: "owner", status: "ready", files: [] };
    let release!: (response: Response) => void;
    vi.mocked(ApiService.apiFetch).mockImplementationOnce(() => new Promise(done => { release = done; }))
      .mockResolvedValue(new Response(JSON.stringify(value)));
    const before = vi.mocked(ApiService.apiFetch).mock.calls.length;
    const signal = new AbortController().signal;
    const initial = OneCopyPresentationService.status(session, requestId, signal);
    const burst = Array.from({ length: 6 }, () => OneCopyPresentationService.status(session, requestId, signal, true));
    expect(vi.mocked(ApiService.apiFetch).mock.calls.length - before).toBe(1);
    release(new Response(JSON.stringify(value))); await Promise.all([initial, ...burst]);
    expect(vi.mocked(ApiService.apiFetch).mock.calls.length - before).toBe(2);
    expect(OneCopyPresentationService.peekStatus(session, requestId)).toEqual(value);
    await OneCopyPresentationService.status(session, requestId, signal);
    expect(vi.mocked(ApiService.apiFetch).mock.calls.length - before).toBe(2);
    vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(new Response("", { status: 403 }));
    await expect(OneCopyService.status(session, requestId, signal)).rejects.toThrow("one_copy_unavailable");
    advanceVaultSessionEpoch(); expect(OneCopyPresentationService.peekStatus(session, requestId)).toBeNull();
    CacheService.getInstance().clear();
  });
});
