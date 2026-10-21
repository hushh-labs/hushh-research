import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useFeedHistoryPresentation } from "@/lib/feed/use-feed-history-presentation";
import { bumpFeedPresentationRevision, currentFeedPresentationRevision } from "@/lib/cache/feed-invalidation-epoch";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";

import {
  appendFeedPage,
  createFeedPaginationState,
  isFeedIdAtOrBefore,
  latestFeedId,
  reconcileFeedFirstPage,
} from "@/lib/feed/feed-pagination";
import type { FeedItem, FeedListResponse } from "@/lib/services/feed-service";

function item(id: number): FeedItem {
  return {
    id: String(id),
    source_domain: "connections",
    event_type: "connection_accepted",
    actor_label: null,
    metadata: {},
    read: false,
    created_at: new Date(1_700_000_000_000 + id * 1_000).toISOString(),
  };
}

function page(ids: number[], nextCursor: string | null): FeedListResponse {
  return {
    items: ids.map(item),
    next_cursor: nextCursor,
    unread_count: ids.length,
  };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: from - to + 1 }, (_, index) => from - index);
}

describe("Feed history reading continuity", () => {
  let root: HTMLDivElement;
  beforeEach(() => {
    CacheService.getInstance().clear();
    publishValidatedAuthSessionOwner("reader");
    root = document.createElement("div");
    root.dataset.appScrollRoot = "true";
    document.body.append(root);
  });
  afterEach(() => { cleanup(); root.remove(); CacheService.getInstance().clear(); });

  it("retains the reading position and existing row updates until new history is requested", () => {
    const initial = page([3, 2, 1], "older");
    const { result, rerender } = renderHook(({ data }) => useFeedHistoryPresentation("reader", data), { initialProps: { data: initial } });
    act(() => { root.scrollTop = 600; root.dispatchEvent(new Event("scroll")); });
    const updated = page([4, 3, 2], "new-older");
    updated.items[1]!.actor_label = "Updated label";
    rerender({ data: updated });
    expect(result.current.page!.items.map((row) => row.id)).toEqual(["3", "2", "1"]);
    expect(result.current.page!.items[0]!.actor_label).toBe("Updated label");
    expect(result.current.hasNew).toBe(true);
    act(() => result.current.showNew());
    expect(result.current.page!.items[0]!.id).toBe("4");
    expect(root.scrollTop).toBe(0);
  });

  it("restores loaded pages and scroll on an ordinary same-session return", async () => {
    const data = page([5, 4], "4");
    const first = renderHook(() => useFeedHistoryPresentation("reader", data));
    act(() => {
      first.result.current.setPagination((state) => appendFeedPage(state, page([3, 2], "2"), "4"));
      root.scrollTop = 500;
      root.dispatchEvent(new Event("scroll"));
    });
    first.unmount();
    root.scrollTop = 0;
    const second = renderHook(() => useFeedHistoryPresentation("reader", data));
    expect(second.result.current.pagination.additionalItems.map((row) => row.id)).toEqual(["3", "2"]);
    await waitFor(() => expect(root.scrollTop).toBe(500));
    second.unmount();
  });

  it("cannot repopulate presentation memory after sign-out purges it", () => {
    const data = page([3, 2], null);
    const first = renderHook(() => useFeedHistoryPresentation("reader", data));
    publishValidatedAuthSessionOwner(null);
    CacheService.getInstance().invalidateUser("reader");
    first.unmount();
    expect(CacheService.getInstance().peek(CACHE_KEYS.FEED_PRESENTATION("reader"))).toBeNull();
  });

  it("drops deleted chat previews from saved and mounted paginated history", () => {
    const data = page([5, 4], "4");
    const first = renderHook(({ value }) => useFeedHistoryPresentation("reader", value), { initialProps: { value: data } });
    act(() => first.result.current.setPagination((state) => appendFeedPage(state, page([3, 2], "2"), "4")));
    first.unmount();
    const second = renderHook(({ value }) => useFeedHistoryPresentation("reader", value), { initialProps: { value: data } });
    expect(second.result.current.pagination.additionalItems).toHaveLength(2);
    act(() => CacheSyncService.onFeedHistoryMutated("reader"));
    expect(CacheService.getInstance().peek(CACHE_KEYS.FEED_PRESENTATION("reader"))).toBeNull();
    second.rerender({ value: page([5], null) });
    expect(second.result.current.page!.items.map(row => row.id)).toEqual(["5"]);
    expect(second.result.current.pagination.additionalItems).toEqual([]);
    expect(second.result.current.hasNew).toBe(false);
    second.unmount();
    const third = renderHook(() => useFeedHistoryPresentation("reader", null));
    expect(third.result.current.page!.items.map(row => row.id)).toEqual(["5"]);
    expect(third.result.current.pagination.additionalItems).toEqual([]);
  });

  it.each(["before", undefined])("repairs a missed deletion hint from the server revision (%s)", (oldRevision) => {
    const data = { ...page([5, 4], "4"), history_revision: oldRevision };
    const view = renderHook(({ value }) => useFeedHistoryPresentation("reader", value), { initialProps: { value: data } });
    act(() => {
      view.result.current.setPagination(state => appendFeedPage(state, page([3, 2], "2"), "4"));
      root.scrollTop = 500;
      root.dispatchEvent(new Event("scroll"));
    });
    const before = currentFeedPresentationRevision("reader");
    view.rerender({ value: { ...page([6, 5], null), history_revision: "after" } });
    expect(view.result.current.page!.items.map(row => row.id)).toEqual(["6", "5"]);
    expect(view.result.current.pagination.additionalItems).toEqual([]);
    expect(view.result.current.hasNew).toBe(false);
    expect(currentFeedPresentationRevision("reader")).toBeGreaterThan(before);
  });

  it.each(["dismiss", "clear", "undo"])("cannot re-save obsolete rows after a confirmed %s", () => {
    const data = page([3, 2], null);
    const first = renderHook(() => useFeedHistoryPresentation("reader", data));
    bumpFeedPresentationRevision("reader");
    CacheService.getInstance().invalidate(CACHE_KEYS.FEED_PRESENTATION("reader"));
    first.unmount();
    const second = renderHook(() => useFeedHistoryPresentation("reader", null));
    expect(second.result.current.page).toBeNull();
    expect(second.result.current.pagination.additionalItems).toEqual([]);
  });
});

describe("Feed live pagination", () => {
  it("carries a displaced first-page tail forward without changing a continuous cursor", () => {
    let state = reconcileFeedFirstPage(
      createFeedPaginationState(),
      page(range(100, 81), "81"),
    );

    state = reconcileFeedFirstPage(state, page(range(105, 86), "86"));

    expect(state.nextCursor).toBe("81");
    expect(state.additionalItems.map((entry) => entry.id)).toEqual(
      range(85, 81).map(String),
    );

    state = appendFeedPage(state, page(range(80, 61), "61"), "81");
    expect(state.nextCursor).toBe("61");
    expect(
      new Set([...state.previousFirstPageItems, ...state.additionalItems]).size,
    ).toBe(45);
  });

  it("restarts from the refreshed cursor when more than one page arrives", () => {
    let state = reconcileFeedFirstPage(
      createFeedPaginationState(),
      page(range(100, 81), "81"),
    );
    state = appendFeedPage(state, page(range(80, 61), "61"), "81");

    state = reconcileFeedFirstPage(state, page(range(125, 106), "106"));

    expect(state.nextCursor).toBe("106");
    expect(state.additionalItems.map((entry) => entry.id)).toContain("100");
    expect(state.additionalItems.map((entry) => entry.id)).toContain("61");
  });

  it("does not let a late load-more response advance a cursor reset by refresh", () => {
    let state = reconcileFeedFirstPage(
      createFeedPaginationState(),
      page(range(100, 81), "81"),
    );
    const requestedCursor = state.nextCursor!;

    state = reconcileFeedFirstPage(state, page(range(125, 106), "106"));
    state = appendFeedPage(state, page(range(80, 61), "61"), requestedCursor);

    expect(state.nextCursor).toBe("106");
    expect(state.additionalItems.map((entry) => entry.id)).toContain("80");
  });

  it("clears retained history when the authoritative first page becomes empty", () => {
    let state = reconcileFeedFirstPage(
      createFeedPaginationState(),
      page(range(20, 1), "1"),
    );
    state = reconcileFeedFirstPage(state, page([], null));

    expect(state.previousFirstPageItems).toEqual([]);
    expect(state.additionalItems).toEqual([]);
    expect(state.nextCursor).toBeNull();
  });

  it("uses the greatest append-only row id as the clear and read watermark", () => {
    const items = [item(2), item(5), item(3)];

    expect(latestFeedId(items)).toBe("5");
    expect(latestFeedId([])).toBeNull();
    expect(latestFeedId([{ ...item(1), id: "not-an-id" }])).toBeNull();
    expect(latestFeedId([{ ...item(1), id: "0" }])).toBeNull();
  });

  it("never hides a higher-id row whose timestamp tied or moved backwards", () => {
    const cleared = { ...item(5), created_at: "2026-01-02T00:00:00.000Z" };
    const appended = {
      ...item(6),
      created_at: "2026-01-01T00:00:00.000Z",
    };

    expect(isFeedIdAtOrBefore(cleared.id, "5")).toBe(true);
    expect(isFeedIdAtOrBefore(appended.id, "5")).toBe(false);
    expect(isFeedIdAtOrBefore("not-an-id", "5")).toBe(false);
    expect(isFeedIdAtOrBefore("6", "not-an-id")).toBe(false);
  });
});


describe("grouped chat pagination", () => {
  const chat = (id: number, key: string): FeedItem => ({ ...item(id), event_type: "direct_message_received", metadata: { chat_thread_key: key } });
  it("replaces an older conversation representative when the chat moves to the first page", () => {
    let state = reconcileFeedFirstPage(createFeedPaginationState(), { ...page([100], "100"), items: [item(100)] });
    state = appendFeedPage(state, { ...page([], "80"), items: [chat(90, "direct:a"), chat(80, "direct:b")] }, "100");
    state = reconcileFeedFirstPage(state, { ...page([], "100"), items: [chat(110, "direct:a"), item(100)] });
    expect(state.additionalItems.map(row => row.id)).toEqual(["80"]);
    expect(state.previousFirstPageItems[0]?.id).toBe("110");
  });
  it("does not re-add a stale grouped row from an in-flight older page", () => {
    let state = reconcileFeedFirstPage(createFeedPaginationState(), { ...page([], "100"), items: [chat(110, "direct:a")] });
    state = appendFeedPage(state, { ...page([], null), items: [chat(90, "direct:a"), chat(80, "direct:b")] }, "100");
    expect(state.additionalItems.map(row => row.id)).toEqual(["80"]);
  });
});


it("restarts pagination when only a moved conversation overlaps logically", () => {
  const conversation = (id: number): FeedItem => ({ ...item(id), event_type: "direct_message_received", metadata: { chat_thread_key: "direct:a" } });
  let state = reconcileFeedFirstPage(createFeedPaginationState(), { ...page(range(100, 81), "81"), items: [conversation(100), ...range(99, 81).map(item)] });
  state = reconcileFeedFirstPage(state, { ...page(range(125, 106), "106"), items: [conversation(125), ...range(124, 106).map(item)] });
  expect(state.nextCursor).toBe("106");
  expect(state.additionalItems.some(row => row.id === "100")).toBe(false);
  expect(state.additionalItems.some(row => row.id === "99")).toBe(true);
});
