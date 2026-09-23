export const CONNECT_DIRECTORY_MENU_CLASSNAME =
  "absolute left-0 top-full z-30 mt-1 w-[184px] overflow-hidden rounded-[14px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-1 shadow-[0_10px_30px_rgba(0,0,0,0.10)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.35)]";

export const CONNECT_WEB_DIRECTORY_POPOVER_CLASSNAME =
  "w-[184px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-[18px] border border-[color:var(--app-card-border-standard)] bg-popover/95 p-1.5 shadow-[0_18px_48px_-24px_rgba(15,23,42,0.44)] backdrop-blur-2xl backdrop-saturate-[180%] supports-[backdrop-filter]:bg-popover/90 dark:shadow-[0_18px_52px_-24px_rgba(0,0,0,0.72)]";

export const CONNECT_CONNECTIONS_SUMMARY_TRAILING_CLASSNAME =
  "flex shrink-0 items-center gap-2";

export const CONNECT_CONNECTIONS_SUMMARY_COUNT_CLASSNAME =
  "ui-text-helper-text min-w-5 text-right tabular-nums text-[color:var(--app-secondary-label)]";

export const CONNECT_CONNECTIONS_SUMMARY_CHEVRON_CLASSNAME =
  "h-4 w-4 shrink-0 text-[color:var(--app-secondary-label)] transition-transform duration-150 ease-out motion-reduce:transition-none group-data-[state=open]/connections:rotate-180";

/**
 * The app scroll root is the only vertical scroll owner on Connect.
 *
 * Do not add `overflow-x-hidden` here: CSS computes the otherwise-visible y
 * axis to `auto`, silently turning this region into a second scroll container.
 * That breaks the sticky tab/search bands and traps phone gestures. The route
 * shell already clips horizontal overflow.
 */
export const CONNECT_PAGE_CONTENT_CLASSNAME = "min-w-0";

/**
 * SwipeViews clips neighbouring panes. Give its clipping viewport an 8px
 * guard on either side, then restore the content's original alignment inside
 * each pane. Without this, the Circles heading and first tile sit flush with
 * the clip edge: a sub-pixel swipe offset can trim the first letter, and the
 * tile's hover/focus border is cut at the same edge.
 */
export const CONNECT_SWIPE_CLIP_GUARD_CLASSNAME =
  "-mx-2 w-[calc(100%+1rem)]";
export const CONNECT_SWIPE_PANE_INSET_CLASSNAME = "px-2";

/** Let identities use the room a responsive row gives them instead of cutting
 * meaningful names and masked contact details behind an ellipsis. */
export const CONNECT_WRAPPING_TEXT_CLASSNAME =
  "block min-w-0 whitespace-normal [overflow-wrap:anywhere]";

/** A source badge may wrap after a long identity without forcing the identity
 * itself to disappear. */
export const CONNECT_WRAPPING_TITLE_ROW_CLASSNAME =
  "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5";

/**
 * The roster is bounded on every viewport, phones included.
 *
 * It was previously capped only from `sm` up, because an earlier phone cap (at
 * 232px) let touch gestures get trapped in the inner scroller and let the fixed
 * bottom chrome sit over whichever row owned the gesture. Leaving phones
 * uncapped fixed those two problems by making the roster arbitrarily long
 * instead, which is its own bug: a few hundred connections push the directory
 * section below them out of reach.
 *
 * `overscroll-contain` is what makes the bound safe this time. It stops a
 * scroll that reaches the roster's end from chaining into the page behind it,
 * which is the gesture trap the original comment described; the finance
 * holdings roster already relies on the same mitigation on phones. The cap is
 * expressed against `dvh` so it shrinks with the visible viewport rather than
 * measuring a phone as though its browser chrome were not there, which keeps
 * the bottom of the list clear of the fixed bottom bars.
 *
 * The `min(42dvh, 18rem)` shape matches the RIA option lists, so the two read
 * as the same control.
 */
export const CONNECT_CONNECTION_LIST_CLASSNAME =
  "max-h-[min(42dvh,18rem)] overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]";
