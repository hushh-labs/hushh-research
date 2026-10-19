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
// Inert panes still paint. The Connections sticky search has negative gutters
// that otherwise cross into Circles. Clip only the inactive pane horizontally;
// `clip` preserves the app scroll root and the active search's sticky behavior.
export const CONNECT_SWIPE_PANE_INSET_CLASSNAME =
  "px-2 [[role=tabpanel][aria-hidden=true]_&]:overflow-x-clip";

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
 * My connections is part of the page, not a scroller of its own.
 *
 * The roster used to be capped (`max-h-[min(60dvh,28rem)] overflow-y-auto`)
 * with `overscroll-contain`. On a phone that made a finger resting on the list
 * scroll the list, and once the list reached an end `overscroll-contain`
 * refused to hand the gesture to the page, so People and everything under it
 * could not be reached from there (founder, 2026-10-18: "parent scrolling is
 * not working"). Connections load a page at a time ("Load more connections"),
 * and the rows are compact, so the list flows in the app scroll root like the
 * rest of the page. Held by __tests__/app/connect/page-client.test.tsx and
 * e2e/connect-page-grid.layout.spec.ts.
 */

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
