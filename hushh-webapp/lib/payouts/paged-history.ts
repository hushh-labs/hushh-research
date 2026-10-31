/**
 * A newest-first, keyset-paged list whose rows change state but keep their id.
 *
 * A live refresh re-reads the first page (the "head"); "More" appends the next
 * older page. Neither may drop what the person already loaded:
 * - reconcileHead keeps every loaded row. When the new head overlaps the
 *   previous head the cursor chain is unbroken, so the older-page cursor stays.
 *   When it does not (a full page or more of new rows arrived), the cursor
 *   restarts after the new head so the unknown gap is read next; loaded rows
 *   stay, deduplicated.
 * - appendPage ignores a page whose cursor is no longer current, so a "More"
 *   that raced a restart cannot skip the gap.
 * - upsertItems replaces loaded rows in place by id.
 *
 * Rows are kept sorted by the caller's order, so a row read later (a gap row,
 * a newer state) lands in its place. Pure: no React and no I/O. Generalises
 * reconcileFeedFirstPage/appendFeedPage (lib/feed/feed-pagination.ts).
 */

export type PagedHistoryPage<T> = {
  items: readonly T[];
  nextCursor: string | null;
};

export type PagedHistoryOrder<T> = {
  /** Stable identity: a row keeps its id while its state changes. */
  id: (item: T) => string;
  /** Newest first: negative when `a` is newer than `b`. */
  compare: (a: T, b: T) => number;
  /** Whether `incoming` replaces `current` for the same id. Default: always. */
  replaces?: (incoming: T, current: T) => boolean;
};

export type PagedHistory<T> = {
  /** Every loaded row, newest first, one per id. */
  readonly items: readonly T[];
  /** Ids from the latest head read; overlap with the next head proves the cursor chain. */
  readonly headIds: readonly string[];
  /** Cursor for the next older page; null once the end is loaded. */
  readonly nextCursor: string | null;
  readonly initialized: boolean;
};

export function createPagedHistory<T>(): PagedHistory<T> {
  return { items: [], headIds: [], nextCursor: null, initialized: false };
}

function newestFirstIds(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

function merge<T>(current: readonly T[], incoming: readonly T[], order: PagedHistoryOrder<T>): T[] {
  const byId = new Map<string, T>();
  for (const item of current) byId.set(order.id(item), item);
  for (const item of incoming) {
    const id = order.id(item);
    const existing = byId.get(id);
    if (existing === undefined || (order.replaces?.(item, existing) ?? true)) byId.set(id, item);
  }
  return [...byId.values()].sort((a, b) => order.compare(a, b) || newestFirstIds(order.id(a), order.id(b)));
}

/** Merge a fresh first page without dropping older pages or breaking the cursor chain. */
export function reconcileHead<T>(
  state: PagedHistory<T>,
  page: PagedHistoryPage<T>,
  order: PagedHistoryOrder<T>,
): PagedHistory<T> {
  const headIds = [...new Set(page.items.map(order.id))];
  if (!state.initialized) {
    return { items: merge([], page.items, order), headIds, nextCursor: page.nextCursor, initialized: true };
  }
  // The server lists every row it has, so an empty first page means none.
  if (page.items.length === 0) return { items: [], headIds: [], nextCursor: null, initialized: true };
  const previous = new Set(state.headIds);
  const continuous = headIds.some((id) => previous.has(id));
  return {
    items: merge(state.items, page.items, order),
    headIds,
    nextCursor: continuous ? state.nextCursor : page.nextCursor,
    initialized: true,
  };
}

/** Append one older page, unless a head refresh moved the cursor since it was requested. */
export function appendPage<T>(
  state: PagedHistory<T>,
  page: PagedHistoryPage<T>,
  requestedCursor: string,
  order: PagedHistoryOrder<T>,
): PagedHistory<T> {
  if (!state.initialized || state.nextCursor === null || state.nextCursor !== requestedCursor) return state;
  return { ...state, items: merge(state.items, page.items, order), nextCursor: page.nextCursor };
}

/**
 * Replace loaded rows in place. A row that is not loaded yet joins only when it
 * sorts inside the loaded range; older rows arrive with their page.
 */
export function upsertItems<T>(
  state: PagedHistory<T>,
  items: readonly T[],
  order: PagedHistoryOrder<T>,
): PagedHistory<T> {
  if (!state.initialized || items.length === 0) return state;
  const loaded = new Set(state.items.map(order.id));
  const oldest = state.items[state.items.length - 1];
  const accepted = items.filter((item) => loaded.has(order.id(item)) || state.nextCursor === null ||
    oldest === undefined || order.compare(item, oldest) <= 0);
  if (accepted.length === 0) return state;
  return { ...state, items: merge(state.items, accepted, order) };
}
