/** Fired after FeedService.markRead resolves, so the tab badge updates
 * immediately instead of waiting for the next poll. */
export const FEED_STATE_CHANGED_EVENT = "hushh:feed-state-changed";

export function dispatchFeedStateChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FEED_STATE_CHANGED_EVENT));
}
