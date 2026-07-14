import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: vi.fn(),
  },
}));

import { ApiService } from "@/lib/services/api-service";
import { CacheService } from "@/lib/services/cache-service";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";

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
});
