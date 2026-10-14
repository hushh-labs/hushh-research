import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mockApiFetch },
}));

import { FeedService } from "@/lib/services/feed-service";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { bumpFeedInvalidationEpoch } from "@/lib/cache/feed-invalidation-epoch";

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

  it("dismisses and restores server rows, and clears a bounded snapshot", async () => {
    mockApiFetch
      .mockResolvedValueOnce(jsonResponse({ status: "ok", dismissal_token: "token-42" }))
      .mockResolvedValueOnce(jsonResponse({ status: "ok", restored: true }))
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    const options = { idToken: "token", userId: "user-1" };
    const cacheKey = CACHE_KEYS.FEED_LIST(options.userId);
    const countKey = CACHE_KEYS.FEED_UNREAD_COUNT(options.userId);
    cache.set(cacheKey, { items: [], next_cursor: null, unread_count: 2 });
    cache.set(countKey, 2);

    const dismissalToken = await FeedService.dismiss({ ...options, itemId: "42" });
    expect(dismissalToken).toBe("token-42");
    expect(mockApiFetch.mock.calls[0][0]).toBe("/api/one/feed/42/dismiss");
    expect(cache.get(cacheKey)).toBeNull();
    expect(cache.get(countKey)).toBeNull();
    await expect(FeedService.restore({
      ...options, itemId: "42", dismissalToken: "token-42",
    })).resolves.toBe(true);
    expect(mockApiFetch.mock.calls[1][0]).toBe("/api/one/feed/42/restore");
    expect(JSON.parse(String(mockApiFetch.mock.calls[1][1].body))).toEqual({
      dismissal_token: "token-42",
    });
    await FeedService.clear({ ...options, upToId: "9007199254740993" });
    expect(mockApiFetch.mock.calls[2][0]).toBe("/api/one/feed/clear");
    expect(JSON.parse(String(mockApiFetch.mock.calls[2][1].body))).toEqual({
      up_to_id: "9007199254740993",
    });
  });

  it("keeps a dismissed row gone after sign-out and same-account sign-in", async () => {
    const serverItems = new Map<string, { id: string }>([["42", { id: "42" }]]);
    mockApiFetch.mockImplementation(async (path: string, init: RequestInit) => {
      if (path === "/api/one/feed/42/dismiss") {
        expect(init.headers).toMatchObject({ Authorization: "Bearer session-one" });
        serverItems.delete("42");
        return jsonResponse({ status: "ok", dismissal_token: "dismissal-42" });
      }
      expect(path).toBe("/api/one/feed");
      return jsonResponse({
        items: [...serverItems.values()],
        next_cursor: null,
        unread_count: serverItems.size,
      });
    });

    const first = await FeedService.list({ idToken: "session-one", userId: "user-1" });
    expect(first.items.map((item) => item.id)).toEqual(["42"]);
    await FeedService.dismiss({ idToken: "session-one", userId: "user-1", itemId: "42" });
    expect((await FeedService.list({ idToken: "session-one", userId: "user-1" })).items).toEqual([]);

    CacheSyncService.onAuthSignedOut("user-1");
    serverItems.set("43", { id: "43" });
    const nextSession = await FeedService.list({ idToken: "session-two", userId: "user-1" });
    expect(nextSession.items.map((item) => item.id)).toEqual(["43"]);
    expect(mockApiFetch.mock.calls.filter(([path]) => path === "/api/one/feed")).toHaveLength(3);
    expect(mockApiFetch.mock.lastCall?.[1].headers).toMatchObject({
      Authorization: "Bearer session-two",
    });
  });

  it("does not claim a stale Undo restored a server row", async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ status: "ok", restored: false }));
    await expect(FeedService.restore({
      idToken: "token", userId: "user-1", itemId: "42", dismissalToken: "stale",
    })).resolves.toBe(false);
  });

  it("does not invalidate a confirmed Feed snapshot when dismissal fails", async () => {
    const cacheKey = CACHE_KEYS.FEED_LIST("user-1");
    cache.set(cacheKey, { items: [], next_cursor: null, unread_count: 2 });
    mockApiFetch.mockResolvedValue(jsonResponse({ error: "Unavailable" }, 503));

    await expect(FeedService.dismiss({
      idToken: "token", userId: "user-1", itemId: "42",
    })).rejects.toThrow("Unavailable");
    expect(cache.get(cacheKey)).toMatchObject({ unread_count: 2 });
  });

  it("does not let pre-read list/count responses repopulate a cleared Feed snapshot", async () => {
    const pending: Array<(response: Response) => void> = [];
    mockApiFetch.mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));
    const oldList = FeedService.list({ idToken: "token", userId: "user-1", force: true });
    const oldCount = FeedService.unreadCount({ idToken: "token", userId: "user-1", force: true });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    bumpFeedInvalidationEpoch("user-1");
    mockApiFetch.mockResolvedValue(jsonResponse({ items: [], next_cursor: null, unread_count: 1 }));
    await FeedService.list({ idToken: "token", userId: "user-1", force: true });
    pending[0](jsonResponse({ items: [], next_cursor: null, unread_count: 3 }));
    pending[1](jsonResponse({ unread_count: 3 }));
    await Promise.all([oldList, oldCount]);
    expect(cache.get(CACHE_KEYS.FEED_UNREAD_COUNT("user-1"))).toBe(1);
    expect(cache.get(CACHE_KEYS.FEED_LIST("user-1"))).toMatchObject({ unread_count: 1 });
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
