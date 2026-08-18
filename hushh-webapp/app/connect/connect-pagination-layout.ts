/**
 * Geometry for Connect's people-list pagination footer, in one place both the
 * screen and `e2e/connect-pagination.layout.spec.ts` read from.
 *
 * QA found Prev/Next dropped onto their own line, below "Page N · Per page":
 * the row was `flex-col`, switching to `flex-row` only at Tailwind's `sm:`
 * (640px) breakpoint. The app never renders this footer above phone width, so
 * that breakpoint never fired and the row was `flex-col` on every device it
 * ships to. Fixed by making the row unconditionally `flex-row` -- there was
 * never a width this needed to stack at.
 */

/** The footer's own row: one line, page info left, Prev/Next flush right. */
export const CONNECT_PAGINATION_ROW_CLASSNAME =
  "flex flex-row items-center justify-between gap-3 px-3 py-3";

/** Page indicator + page-size selector, sharing the row's left side. Neither
 *  cluster shrinks: a flex item's default `min-width: auto` is its
 *  min-content size, and for unbroken text that is the width of its longest
 *  WORD -- so a tight row shrank "Page 4" until "4" wrapped under "Page"
 *  before this, the same failure mode one line lower. */
export const CONNECT_PAGINATION_LEFT_CLASSNAME =
  "flex min-h-9 shrink-0 items-center gap-2";

/** Prev/Next, sharing the row's right side. */
export const CONNECT_PAGINATION_RIGHT_CLASSNAME =
  "flex min-h-9 shrink-0 items-center justify-end gap-2";

/** The page-size `<Select>` trigger. */
export const CONNECT_PAGE_SIZE_TRIGGER_CLASSNAME =
  "h-8 min-h-8 w-[74px] rounded-2xl text-[15px] font-medium leading-5";

/** Prev/Next buttons, before the shared `Button` `size="sm"` classes apply. */
export const CONNECT_PAGER_BUTTON_CLASSNAME =
  "h-8 min-h-8 rounded-2xl px-3 text-[14px] font-semibold leading-[18px]";
