import { describe, expect, it } from "vitest";

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
