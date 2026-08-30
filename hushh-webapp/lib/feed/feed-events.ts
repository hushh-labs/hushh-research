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
 * - `arrived` — new activity exists that this device did not cause: a push
 *   landed while the app was open, or the user's own write just succeeded.
 *   Handled exactly like `action`; it is named separately because the two
 *   answer different questions when reading a trace, and because "the Feed is
 *   not live" was diagnosed by finding that nothing dispatched anything at all
 *   when a push arrived — the Feed simply waited out its 45s timer.
 */
export type FeedStateChangeReason = "read" | "action" | "arrived";

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
 *  so an untagged legacy dispatch still refreshes everything.
 *
 *  `arrived` is preserved rather than folded into `action`. Both refresh, so
 *  collapsing them changed no behaviour -- it only threw away the one thing
 *  that distinguishes "the server told us" from "the reader pressed something"
 *  at exactly the point someone would be reading a trace to find out why the
 *  Feed did or did not update. */
export function feedStateChangeReason(event: Event): FeedStateChangeReason {
  const detail = (event as CustomEvent<Partial<FeedStateChangedDetail>>).detail;
  if (detail?.reason === "read") return "read";
  if (detail?.reason === "arrived") return "arrived";
  return "action";
}
