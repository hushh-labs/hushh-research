/**
 * Geometry for Connect's search row, in one place both the screen and the
 * browser layout contract read from.
 *
 * The row is a search field and a selection toggle sharing one line. QA found
 * it clipped on a phone: the placeholder rendered as "Search people by nam".
 * Three separate things were spending the row's width, and only one of them
 * was the label:
 *
 *  1. The placeholder was five words where two carry the meaning.
 *  2. The toggle said "Select multiple" -- ~55px explaining a mode whose own
 *     section description already explains it.
 *  3. The field reserved `pr-11` (44px) for the clear button at all times,
 *     including while empty -- i.e. at exactly the moment the placeholder is
 *     the only thing in the field and the button does not exist.
 *
 * Values live here rather than inline so `e2e/connect-circle-cta.layout.spec.ts`
 * can measure the real strings. A fixture that hand-copies them stops proving
 * anything the first time one changes.
 */

/** Two words. The narrowest supported phone has to be able to read all of it. */
export const CONNECT_SEARCH_PLACEHOLDER = "Search people";

/** Left inset clears the search glyph; the right one is conditional. */
export const CONNECT_SEARCH_INPUT_CLASSNAME = "h-10 pl-11";

/** Added only while the clear button is actually in the gutter. */
export const CONNECT_SEARCH_INPUT_CLEARABLE_CLASSNAME = "pr-11";

/** Used while the gutter is empty, so the placeholder gets the space back. */
export const CONNECT_SEARCH_INPUT_PLAIN_CLASSNAME = "pr-3.5";

/**
 * The selection toggle, at a fixed width so switching between "Select many"
 * and "Cancel" cannot resize the search field beside it.
 *
 * 104px, not 84px: the label has to say that it selects MORE THAN ONE person
 * before it is pressed. "Select" alone read as "select this one", which is the
 * opposite of what the control does. The width is measured against the widest
 * of the two labels at 320px in `connect-circle-cta.layout.spec.ts`.
 */
export const CONNECT_SELECT_TOGGLE_CLASSNAME =
  "h-10 min-h-10 w-[104px] shrink-0 rounded-full px-0 text-[15px] font-semibold leading-5";

/** Gap between the field and the toggle (`gap-2`). */
export const CONNECT_SEARCH_ROW_GAP_PX = 8;

/* ------------------------------------------------------------------ */
/* The pager at the foot of the directory card.                        */
/* ------------------------------------------------------------------ */

/**
 * THE PAGER ROW.
 *
 * One line at every width. It used to be `flex-col ... sm:flex-row`, so on
 * every phone the app actually ships to it broke into "Page 1 - Per page [8]"
 * and, underneath, a right-aligned "Prev  Next" -- four fragments with three
 * different alignments stacked at the bottom of the card. The size control and
 * the buttons that walk the list belong on the same line: they are the two
 * halves of one decision.
 *
 * `justify-between` rather than a spacer, and both clusters keep their
 * intrinsic width, so the row's total is measured rather than assumed. See
 * `connect-circle-cta.layout.spec.ts`, which fails the moment it wraps at any
 * shipped phone width.
 */
export const CONNECT_PAGER_ROW_CLASSNAME =
  "flex items-center justify-between gap-3 border-t border-[color:var(--app-card-border-standard)] px-3 py-3";

/**
 * The per-page select.
 *
 * 68px, not 74px: the widest option is two digits, and the row now has to hold
 * Prev and Next beside it on a 320px screen. Every pixel this control does not
 * need is a pixel the row cannot afford to give it.
 */
export const CONNECT_PAGE_SIZE_TRIGGER_CLASSNAME =
  "h-8 min-h-8 w-[68px] shrink-0 rounded-2xl text-[15px] font-medium leading-5";

/**
 * "Page 1", under the control rather than beside it.
 *
 * Deliberately smaller than `ui-text-helper-text` (13px) and a step quieter in
 * colour: it is the only thing in the row that is a READING of the list rather
 * than a way to change it, and at the same size it competed with the label of
 * the control it sits under.
 */
export const CONNECT_PAGE_STATUS_CLASSNAME =
  "font-[family-name:var(--font-app-body)] text-[11px] font-normal leading-4 tracking-[0.01em] tabular-nums text-[color:var(--app-tertiary-label)]";

/**
 * Prev, Next and "Load more connections". Lives here rather than in the screen
 * so the browser contract can measure the button the screen really renders.
 */
export const CONNECT_PAGER_BUTTON_CLASSNAME =
  "h-8 min-h-8 rounded-2xl px-3 text-[14px] font-semibold leading-[18px]";

/**
 * Prev and Next only. `px-2.5`, not `px-3`, for the same reason the select
 * shrank: the row is measured at 320px and the two buttons are the half of it
 * that cannot be dropped. `min-w-[44px]` keeps the touch target legal.
 */
export const CONNECT_PAGER_BUTTON_EXTRA_CLASSNAME = "min-w-[44px] px-2.5";
