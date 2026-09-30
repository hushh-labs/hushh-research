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
export const CONNECT_SWIPE_CLIP_GUARD_CLASSNAME = "-mx-2 w-[calc(100%+1rem)]";
export const CONNECT_SWIPE_PANE_INSET_CLASSNAME = "px-2";

/** Let identities use the room a responsive row gives them instead of cutting
 * meaningful names and masked contact details behind an ellipsis. */
export const CONNECT_WRAPPING_TEXT_CLASSNAME =
  "block min-w-0 whitespace-normal [overflow-wrap:anywhere]";

/** Keep contact provenance predictable beside variable-length identities.
 *
 * Phone rows always place the badge below the name, even when a short name
 * would leave enough inline room. At `sm` and above the existing inline,
 * wrapping desktop layout returns. This avoids a mixed phone list where the
 * same badge changes rows only for longer names.
 */
export const CONNECT_WRAPPING_TITLE_ROW_CLASSNAME =
  "flex min-w-0 flex-col items-start gap-y-0.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-1.5";

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

/**
 * Connect's section headings stand on the page's content column.
 *
 * The shared group heading carries a 4px inline inset of its own, and "My
 * connections" then sat inside a bordered, filled pill with 12px of padding,
 * so its label started 17px in from the column the Circles card, the tab
 * rail and both lists share (founder, 2026-09-29: "the border and padding for
 * the my connections can be removed ... it can be grid symmetrical"). With
 * no inset the leading label starts on the column and the trailing control
 * ends on it. 8px, not 6px, down to the list keeps the rhythm on the grid.
 *
 * Held by e2e/connect-page-grid.layout.spec.ts.
 */
export const CONNECT_SECTION_HEADING_CLASSNAME = "mb-2 px-0";

/** A section title that is also a control: a bare label and its chevron,
 * with no border, fill or padding box of its own, like "People". */
export const CONNECT_SECTION_TITLE_CONTROL_CLASSNAME =
  "group inline-flex min-h-11 max-w-full items-center gap-2 rounded-full border-0 bg-transparent px-0 text-left text-[color:var(--app-label)] shadow-none hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]";

/**
 * A row's trailing action ends as far in from the row's right edge as its
 * avatar starts from the left (16px), so every row is symmetric.
 *
 * The shared row keeps its trailing slot 2px (4px from `sm`) further in than
 * its leading edge; on Connect, whose trailing actions are filled controls,
 * that read as a lopsided row. The compensation lives here, not in the
 * shared primitive, because every other surface's rows depend on it.
 */
export const CONNECT_ROW_TRAILING_CLASSNAME = "-mr-0.5 sm:-mr-1";
