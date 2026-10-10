import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: vi.fn(),
  },
}));

import { ApiService } from "@/lib/services/api-service";
import { CacheService } from "@/lib/services/cache-service";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import { getCachedGmailReceipts, primeCachedGmailReceipts } from "@/lib/profile/gmail-receipts-cache";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("GmailReceiptsService.getStatus caching", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheService.getInstance().clear();
  });

  it("serves a repeated call within the TTL from cache instead of hitting the network again", async () => {
    const fetchSpy = vi
      .spyOn(ApiService, "apiFetch")
      .mockResolvedValue(jsonResponse({ connected: true }));

    const first = await GmailReceiptsService.getStatus({
      idToken: "token-1",
      userId: "user-1",
    });
    const second = await GmailReceiptsService.getStatus({
      idToken: "token-1",
      userId: "user-1",
    });

    expect(first.connected).toBe(true);
    expect(second.connected).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache when force is true", async () => {
    const fetchSpy = vi
      .spyOn(ApiService, "apiFetch")
      .mockImplementation(async () => jsonResponse({ connected: true }));

    await GmailReceiptsService.getStatus({ idToken: "token-1", userId: "user-1" });
    await GmailReceiptsService.getStatus({
      idToken: "token-1",
      userId: "user-1",
      force: true,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps separate cache entries per user", async () => {
    const fetchSpy = vi
      .spyOn(ApiService, "apiFetch")
      .mockImplementation(async () => jsonResponse({ connected: true }));

    await GmailReceiptsService.getStatus({ idToken: "token-1", userId: "user-1" });
    await GmailReceiptsService.getStatus({ idToken: "token-2", userId: "user-2" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("purges the disconnected owner's receipt and status caches at the shared service boundary", async () => {
    const fetchSpy = vi.spyOn(ApiService, "apiFetch")
      .mockResolvedValueOnce(jsonResponse({ connected: true }))
      .mockResolvedValueOnce(jsonResponse({ connected: false, status: "disconnected" }))
      .mockResolvedValueOnce(jsonResponse({ connected: false, status: "disconnected" }));
    primeCachedGmailReceipts({
      userId: "user-disconnect", accountKey: "mail@example.com",
      response: {
        items: [{ id: 1, source_kind: "gmail_live", source_id: "source-1", gmail_message_id: "message-1" }],
        page: 1, per_page: 20, total: 1, has_more: false,
      },
    });

    await GmailReceiptsService.getStatus({ idToken: "token", userId: "user-disconnect" });
    await GmailReceiptsService.disconnect({ idToken: "token", userId: "user-disconnect" });
    expect(getCachedGmailReceipts("user-disconnect", "mail@example.com")).toBeNull();
    expect((await GmailReceiptsService.getStatus({ idToken: "token", userId: "user-disconnect" })).connected).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("does not re-cache a connected status GET that finishes after disconnect", async () => {
    let releaseStatus!: (response: Response) => void;
    const fetchSpy = vi.spyOn(ApiService, "apiFetch")
      .mockImplementationOnce(() => new Promise((resolve) => { releaseStatus = resolve; }))
      .mockResolvedValueOnce(jsonResponse({ connected: false, status: "disconnected" }))
      .mockResolvedValueOnce(jsonResponse({ connected: false, status: "disconnected" }));
    const staleGet = GmailReceiptsService.getStatus({ idToken: "token", userId: "user-racing-status" });
    await GmailReceiptsService.disconnect({ idToken: "token", userId: "user-racing-status" });
    releaseStatus(jsonResponse({ connected: true, status: "connected" }));
    await staleGet;

    expect((await GmailReceiptsService.getStatus({ idToken: "token", userId: "user-racing-status" })).connected).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("retains cached rows when disconnect is rejected or still connected", async () => {
    primeCachedGmailReceipts({
      userId: "user-failed-disconnect", accountKey: "mail@example.com",
      response: {
        items: [{ id: 1, source_kind: "gmail_live", source_id: "source-1", gmail_message_id: "message-1" }],
        page: 1, per_page: 20, total: 1, has_more: false,
      },
    });
    vi.spyOn(ApiService, "apiFetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ connected: true, status: "connected" }));

    await expect(GmailReceiptsService.disconnect({ idToken: "token", userId: "user-failed-disconnect" })).rejects.toThrow();
    await expect(GmailReceiptsService.disconnect({ idToken: "token", userId: "user-failed-disconnect" })).rejects.toThrow();
    expect(getCachedGmailReceipts("user-failed-disconnect", "mail@example.com")?.items).toHaveLength(1);
  });

});
