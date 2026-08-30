/**
 * Geometry for Connect's search row, in one place both the screen and the
 * browser layout contract read from.
 *
 * The row is now only the search field. QA found the older side-by-side
 * search/select row clipped on a phone: the placeholder rendered as
 * "Search people by nam". Three separate things were spending the row's width,
 * and only one of them was the label:
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
export const CONNECT_SEARCH_INPUT_CLASSNAME = "h-11 pl-11";

/** Added only while the clear button is actually in the gutter. */
export const CONNECT_SEARCH_INPUT_CLEARABLE_CLASSNAME = "pr-11";

/** Used while the gutter is empty, so the placeholder gets the space back. */
export const CONNECT_SEARCH_INPUT_PLAIN_CLASSNAME = "pr-3.5";

/**
 * The selection toggle, at a fixed width so switching between "Select"
 * and "Cancel" cannot resize the directory header beside it.
 *
 * 72px clears the wider "Cancel" label while keeping the directory name as
 * the dominant control in the header.
 */
export const CONNECT_SELECT_TOGGLE_CLASSNAME =
  "h-10 min-h-10 w-[72px] shrink-0 rounded-full px-0 text-[15px] font-semibold leading-5";

/** Gap between the field and the toggle (`gap-2`). */
export const CONNECT_SEARCH_ROW_GAP_PX = 8;

/* ------------------------------------------------------------------ */
/* The pager at the foot of the directory card.                        */
/* ------------------------------------------------------------------ */

/**
 * THE PAGER ROW.
 *
 * One quiet footer row inside the grouped list. Phone widths show only the
 * visible range and icon buttons; larger widths add the compact page-size
 * control only when it can help.
 *
 * `justify-between` rather than a spacer, and both clusters keep their
 * intrinsic width, so the row's total is measured rather than assumed. See
 * `connect-circle-cta.layout.spec.ts`, which fails the moment it wraps at any
 * shipped phone width.
 */
export const CONNECT_PAGER_ROW_CLASSNAME =
  "flex min-h-14 items-center justify-between gap-3 border-t border-[color:var(--app-card-border-standard)] px-4 py-1 shadow-none";

/**
 * The per-page select.
 *
 * The label is the value: "20 per page". It stays compact and disappears on
 * phone widths where page size is fixed.
 */
export const CONNECT_PAGE_SIZE_TRIGGER_CLASSNAME =
  "h-9 min-h-9 w-auto min-w-[108px] shrink-0 rounded-full border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-secondary-fill)] px-3 text-[14px] font-medium leading-5 shadow-none hover:bg-[color:var(--app-tertiary-fill)]";

/**
 * Visible range, not page chrome. Tabular numbers keep the footer steady while
 * moving through the directory.
 */
export const CONNECT_PAGE_STATUS_CLASSNAME =
  "font-[family-name:var(--font-app-body)] text-[14px] font-medium leading-5 tracking-normal tabular-nums text-[color:var(--app-secondary-label)]";

/**
 * Prev, Next and "Load more connections". Lives here rather than in the screen
 * so the browser contract can measure the button the screen really renders.
 */
export const CONNECT_PAGER_BUTTON_CLASSNAME =
  "h-8 min-h-8 rounded-2xl px-3 text-[14px] font-semibold leading-[18px]";

/**
 * Previous/next only. Icon buttons, never filled pills; the full 44px hit area
 * remains visible even when disabled.
 */
export const CONNECT_PAGER_BUTTON_EXTRA_CLASSNAME =
  "!h-11 !min-h-11 !w-11 !min-w-11 rounded-full bg-transparent !p-0 text-[color:var(--app-secondary-label)] shadow-none hover:bg-[color:var(--app-secondary-fill)] hover:text-[color:var(--app-label)] disabled:opacity-35";
