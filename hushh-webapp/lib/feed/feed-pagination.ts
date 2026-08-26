import type { FeedItem, FeedListResponse } from "@/lib/services/feed-service";

export type FeedPaginationState = {
  previousFirstPageItems: FeedItem[];
  additionalItems: FeedItem[];
  nextCursor: string | null;
  initialized: boolean;
};

export function createFeedPaginationState(): FeedPaginationState {
  return {
    previousFirstPageItems: [],
    additionalItems: [],
    nextCursor: null,
    initialized: false,
  };
}

function parseFeedId(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  try {
    const id = BigInt(value);
    return id > 0n ? id : null;
  } catch {
    return null;
  }
}

/** Return the greatest append-only server id represented by the visible rows. */
export function latestFeedId(items: FeedItem[]): string | null {
  let latestValue: string | null = null;
  let latestId: bigint | null = null;
  for (const item of items) {
    const id = parseFeedId(item.id);
    if (id === null || (latestId !== null && id <= latestId)) continue;
    latestId = id;
    latestValue = item.id;
  }
  return latestValue;
}

/** Compare ids without converting bigint database values through Number. */
export function isFeedIdAtOrBefore(
  itemId: string,
  watermarkId: string,
): boolean {
  const item = parseFeedId(itemId);
  const watermark = parseFeedId(watermarkId);
  return item !== null && watermark !== null && item <= watermark;
}

function mergeAdditionalItems(
  firstPageItems: FeedItem[],
  ...itemGroups: FeedItem[][]
): FeedItem[] {
  const firstPageIds = new Set(firstPageItems.map((item) => item.id));
  const seen = new Set<string>();
  const merged: FeedItem[] = [];
  for (const item of itemGroups.flat()) {
    if (firstPageIds.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

/**
 * Reconcile a live first-page refresh with history the person already loaded.
 *
 * When a few new rows arrive, the refreshed page overlaps the previous page;
 * carrying the displaced tail into `additionalItems` keeps the cursor chain
 * continuous. If an entire page (or more) arrived and there is no overlap, the
 * cursor restarts from the refreshed page so the unknown gap is fetched before
 * continuing into the already-loaded history.
 */
export function reconcileFeedFirstPage(
  state: FeedPaginationState,
  page: FeedListResponse,
): FeedPaginationState {
  if (!state.initialized) {
    return {
      previousFirstPageItems: page.items,
      additionalItems: [],
      nextCursor: page.next_cursor,
      initialized: true,
    };
  }

  if (page.items.length === 0) {
    return {
      previousFirstPageItems: [],
      additionalItems: [],
      nextCursor: null,
      initialized: true,
    };
  }

  const nextIds = new Set(page.items.map((item) => item.id));
  const pagesOverlap = state.previousFirstPageItems.some((item) =>
    nextIds.has(item.id),
  );

  return {
    previousFirstPageItems: page.items,
    additionalItems: mergeAdditionalItems(
      page.items,
      state.additionalItems,
      state.previousFirstPageItems,
    ),
    nextCursor: pagesOverlap ? state.nextCursor : page.next_cursor,
    initialized: true,
  };
}

/** Append one older page without letting an in-flight stale cursor skip a gap
 * discovered by a simultaneous first-page refresh. */
export function appendFeedPage(
  state: FeedPaginationState,
  page: FeedListResponse,
  requestedCursor: string,
): FeedPaginationState {
  return {
    ...state,
    additionalItems: mergeAdditionalItems(
      state.previousFirstPageItems,
      state.additionalItems,
      page.items,
    ),
    nextCursor:
      state.nextCursor === requestedCursor
        ? page.next_cursor
        : state.nextCursor,
  };
}
