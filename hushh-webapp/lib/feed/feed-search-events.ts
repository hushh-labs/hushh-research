/** UI intent only. Criteria, identities and permission state stay out of events. */
export const FEED_SEARCH_OPEN_EVENT = "one:feed-search-open";
export const FEED_SEARCH_RESET_EVENT = "one:feed-search-reset";
export function openFeedSearch(): void { window.dispatchEvent(new Event(FEED_SEARCH_OPEN_EVENT)); }
export function resetFeedSearchView():void {window.dispatchEvent(new Event(FEED_SEARCH_RESET_EVENT));}
