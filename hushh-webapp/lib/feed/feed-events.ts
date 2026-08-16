/** Fired after FeedService.markRead resolves, so the tab badge updates
 * immediately instead of waiting for the next poll. */
export const FEED_STATE_CHANGED_EVENT = "hushh:feed-state-changed";

/**
 * Why the feed state changed.
 *
 * - `read` — only unread flags moved. The badge must recount; the list already
 *   has these rows and re-fetching them would be a wasted request.
 * - `action` — something was approved, denied, or dismissed, so there is new
 *   activity to load. Every feed surface should re-check.
 */
export type FeedStateChangeReason = "read" | "action";

export type FeedStateChangedDetail = { reason: FeedStateChangeReason };

export function dispatchFeedStateChanged(
  reason: FeedStateChangeReason = "action",
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<FeedStateChangedDetail>(FEED_STATE_CHANGED_EVENT, {
      detail: { reason },
    }),
  );
}

/** Reads the reason off a dispatched event, defaulting to the broader `action`
 *  so an untagged legacy dispatch still refreshes everything. */
export function feedStateChangeReason(event: Event): FeedStateChangeReason {
  const detail = (event as CustomEvent<Partial<FeedStateChangedDetail>>).detail;
  return detail?.reason === "read" ? "read" : "action";
}
