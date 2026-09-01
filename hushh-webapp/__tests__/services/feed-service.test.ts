import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mockApiFetch },
}));

import { FeedService } from "@/lib/services/feed-service";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("FeedService", () => {
  const cache = CacheService.getInstance();

  beforeEach(() => {
    cache.clear();
    mockApiFetch.mockReset();
  });

  afterEach(() => cache.clear());

  it("seeds the unread badge from the same first-page snapshot", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({ items: [], next_cursor: null, unread_count: 7 }),
    );

    await FeedService.list({
      idToken: "token",
      userId: "user-1",
      force: true,
    });

    expect(cache.get(CACHE_KEYS.FEED_UNREAD_COUNT("user-1"))).toBe(7);
    expect(cache.get(CACHE_KEYS.FEED_LIST("user-1"))).toMatchObject({
      unread_count: 7,
    });
  });

  it("posts an exact bigint watermark without JavaScript number coercion", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ status: "ok" }));
    const watermark = "900719925474099312345";

    await FeedService.markRead({ idToken: "token", upToId: watermark });

    const [, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ up_to_id: watermark });
  });

  it("surfaces the backend's safe structured outage message", async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse(
        {
          detail: {
            code: "DATABASE_UNAVAILABLE",
            message: "Feed is temporarily unavailable. Please try again.",
          },
        },
        503,
      ),
    );

    await expect(
      FeedService.list({
        idToken: "token",
        userId: "user-1",
        force: true,
      }),
    ).rejects.toThrow("Feed is temporarily unavailable. Please try again.");
  });
});
