/**
 * Geometry for one person's row in the Circle roster, and for the roster the
 * rows stack into.
 *
 * Reported from phone QA as "scattered" and "not looking good". Measured, the
 * ragged right edge was structural rather than a matter of taste: every row
 * sized its own trailing cluster to whatever that row happened to offer, and
 * one roster offers four different combinations of the same two controls --
 *
 *   the owner, not removable   -> relationship control, kebab
 *   a member you can share to  -> relationship control, kebab
 *   a member you cannot        -> relationship control, no kebab
 *   you                        -> neither
 *
 * -- so the same control landed at three different x positions down four rows,
 * and the kebab column existed on some rows and not others. Nothing was
 * mis-specified in CSS. There was no column to align to.
 *
 * The trailing edge is now two fixed slots. The menu slot is ALWAYS rendered
 * at one width, occupied by an inert spacer on the rows that have no menu, so
 * a row can never move sideways because of what the row above it can do.
 *
 * Values live here rather than inline so a real-browser layout contract can
 * measure the strings the screen actually ships, the same way
 * `circle-name-row-layout.ts` is measured by
 * `e2e/connect-circle-cta.layout.spec.ts`. A fixture that hand-copies them
 * stops proving anything the first time one changes.
 */

/** The kebab, and the spacer that holds its column open. 44px is the platform
 *  minimum touch target, so the slot cannot be narrowed to tighten the row. */
export const CIRCLE_MEMBER_MENU_SLOT_PX = 44;

/** One-line and two-line rows share this floor, so the list keeps a beat even
 *  where a member has no second line to show. */
export const CIRCLE_MEMBER_ROW_MIN_HEIGHT_PX = 64;

/**
 * `items-center`, not `items-start`.
 *
 * The avatar is 44px and the text block is 20px + 18px, so top-aligning the
 * two left the name sitting ~3px proud of the avatar's cap height on every
 * row -- the "not aligned" half of the report, repeated once per member.
 */
export const CIRCLE_MEMBER_ROW_CLASSNAME =
  "flex min-h-16 items-center gap-3 px-4 py-2.5";

export const CIRCLE_MEMBER_AVATAR_CLASSNAME = "h-11 w-11 shrink-0";

/** Names and state copy remain readable at narrow widths. The row may grow
 * vertically; silently replacing an identity with an ellipsis is not an
 * acceptable responsive fallback. */
export const CIRCLE_MEMBER_NAME_ROW_CLASSNAME =
  "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[15px] font-semibold leading-5 text-foreground";

export const CIRCLE_MEMBER_NAME_CLASSNAME =
  "block min-w-0 whitespace-normal [overflow-wrap:anywhere]";

export const CIRCLE_MEMBER_SECONDARY_CLASSNAME =
  "whitespace-normal [overflow-wrap:anywhere]";

/** Circle detail titles share their row with Edit. The copy column must be
 * shrinkable and the title must wrap so neither can push the other off-screen. */
export const CIRCLE_DETAIL_HEADER_CLASSNAME =
  "flex items-start justify-between gap-4 px-1";

export const CIRCLE_DETAIL_HEADER_COPY_CLASSNAME =
  "min-w-0 flex-1 [&_h1]:whitespace-normal [&_h1]:[overflow-wrap:anywhere]";

/** The trailing cluster: right-aligned, fixed slots, never wraps under the
 *  name. `gap-1` keeps the action and the kebab reading as one group. */
export const CIRCLE_MEMBER_TRAILING_CLASSNAME =
  "flex shrink-0 items-center justify-end gap-1";

/**
 * An actionable relationship control (Connect / Respond).
 *
 * `h-9` AND `min-h-9`: `Button`'s size variants set both, and `h-` and
 * `min-h-` are separate tailwind-merge groups, so a caller passing only `h-9`
 * keeps whatever `min-h-` the variant brought and the control renders taller
 * than it asked for. Same trap `circle-name-row-layout.ts` documents.
 */
export const CIRCLE_MEMBER_ACTION_CLASSNAME =
  "h-9 min-h-9 shrink-0 rounded-full px-4 text-[15px] font-semibold";

/** The kebab trigger, and the invisible spacer standing in for it. */
export const CIRCLE_MEMBER_MENU_CLASSNAME = "h-11 w-11 shrink-0 rounded-full";

/**
 * Phones retain one page scroll so touch gestures cannot get trapped inside a
 * nested roster. On larger screens, rosters can be capped for fast access to
 * actions below them.
 */
export const CIRCLE_MEMBERS_CARD_SHELL_CLASSNAME =
  "flex flex-col sm:max-h-[60vh]";

export const CIRCLE_MEMBERS_CARD_SCROLL_CLASSNAME =
  "min-h-0 flex-1 sm:overflow-y-auto sm:overscroll-contain sm:[-webkit-overflow-scrolling:touch]";
