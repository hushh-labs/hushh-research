import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  baseline: vi.fn(),
  personalized: vi.fn(),
  deviceRead: vi.fn(),
  deviceWrite: vi.fn(),
  deviceInvalidate: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getKaiMarketNewsBaseline: mocks.baseline,
    getKaiMarketNews: mocks.personalized,
  },
  MarketNewsSnapshotChangedError: class MarketNewsSnapshotChangedError extends Error {},
}));

vi.mock("@/lib/services/device-resource-cache-service", () => ({
  DeviceResourceCacheService: {
    read: mocks.deviceRead,
    write: mocks.deviceWrite,
    invalidateResource: mocks.deviceInvalidate,
  },
}));

vi.mock("@/lib/cache/request-audit-log", () => ({
  logRequestAudit: vi.fn(),
}));

import { KaiMarketNewsResourceService } from "@/lib/kai/kai-market-news-resource";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";

const page = {
  items: [
    {
      symbol: "AAPL",
      title: "Apple update",
      url: "https://example.test/apple",
      published_at: "2026-07-19T00:00:00Z",
      source_name: "Example",
      provider: "test",
      degraded: false,
    },
  ],
  next_cursor: "cursor-2",
  has_more: true,
  snapshot_id: "snapshot-1",
  generated_at: "2026-07-19T00:00:00Z",
  stale: false,
  cache: { tier: "live" as const, age_seconds: 0, hit: false },
  provider_status: { "news:AAPL": "ok" },
};

describe("KaiMarketNewsResourceService", () => {
  beforeEach(() => {
    CacheService.getInstance().clear();
    vi.clearAllMocks();
    mocks.deviceRead.mockResolvedValue(null);
    mocks.deviceWrite.mockResolvedValue(undefined);
    mocks.baseline.mockResolvedValue(page);
  });

  afterEach(() => {
    CacheService.getInstance().clear();
  });

  it("serves a repeated headline page from L1 instead of issuing another request", async () => {
    const request = {
      userId: "user-1",
      mode: "baseline" as const,
      limit: 12,
    };

    await KaiMarketNewsResourceService.getStaleFirst(request);
    await KaiMarketNewsResourceService.getStaleFirst(request);

    expect(mocks.baseline).toHaveBeenCalledTimes(1);
    expect(mocks.baseline).toHaveBeenCalledWith({
      userId: "user-1",
      cursor: null,
      limit: 12,
      daysBack: 7,
    });
    expect(mocks.deviceWrite).toHaveBeenCalledTimes(1);
  });

  it("uses a separate cursor key while preserving the same bounded request contract", async () => {
    await KaiMarketNewsResourceService.getStaleFirst({
      userId: "user-1",
      mode: "personalized",
      vaultOwnerToken: "owner-token",
      symbols: ["MSFT", "AAPL", "MSFT"],
      cursor: "cursor-2",
      limit: 20,
    });

    expect(mocks.personalized).toHaveBeenCalledWith({
      userId: "user-1",
      vaultOwnerToken: "owner-token",
      symbols: ["MSFT", "AAPL"],
      cursor: "cursor-2",
      limit: 20,
      daysBack: 7,
    });
  });

  it("retains headlines on a failed refresh without presenting the saved page as fresh", async () => {
    const request = { userId: "user-1", mode: "baseline" as const };
    await KaiMarketNewsResourceService.getStaleFirst(request);
    mocks.baseline.mockRejectedValueOnce(new Error("offline"));
    const saved = await KaiMarketNewsResourceService.getStaleFirst({ ...request, forceRefresh: true });
    expect(saved).toMatchObject({ items: page.items, snapshot_id: page.snapshot_id, generated_at: page.generated_at, stale: true });
    const cached = CacheService.getInstance().peek(CACHE_KEYS.KAI_MARKET_NEWS("user-1", "baseline", null, 12, 7));
    expect(cached?.ttl).toBe(0);
    expect(cached?.data).toMatchObject({ stale: true });
    expect(mocks.deviceWrite).toHaveBeenCalledOnce();
    const latest = await KaiMarketNewsResourceService.getStaleFirst({ ...request, forceRefresh: true });
    expect(latest?.stale).toBe(false);
  });

  it("marks restored device headlines stale until an authoritative refresh succeeds", async () => {
    mocks.deviceRead.mockResolvedValue(page);
    const saved = await KaiMarketNewsResourceService.getStaleFirst({ userId: "user-1", mode: "baseline", backgroundRefresh: false });
    expect(saved?.stale).toBe(true);
    expect(saved?.generated_at).toBe(page.generated_at);
    expect(mocks.baseline).not.toHaveBeenCalled();
  });
});
