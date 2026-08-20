/**
 * The three-row shell for the address-details sheet: a pinned header, one
 * scroller, a pinned footer.
 *
 * Exported as plain strings so `e2e/save-location-sheet.layout.spec.ts` can
 * compile and measure the REAL classes in a real browser. A JSDOM test can
 * only prove these strings are on the elements; it performs no layout, so it
 * cannot prove the two things that were actually broken:
 *
 *  1. The header's corner buttons used to be `absolute left-4/right-4 top-4`
 *     inside the sheet's own scroll box, over a header padded to `px-9` (36px).
 *     A 36px button starting at 16px ends at 52px, so it sat ON the title --
 *     and because the sheet itself was the scroller, both drifted apart as
 *     soon as anyone scrolled. They are laid-out flex items now: a row cannot
 *     overlap itself.
 *  2. The footer was `sticky bottom-0` on a `/95` translucent background, so
 *     the last field showed THROUGH the primary button. It is a real flex row
 *     outside the scroller now, on a solid surface.
 */

/**
 * Sheet shell while the details pane is on screen. Turns the dialog from "one
 * long scroll box with padding" into a fixed frame whose middle row scrolls.
 *
 * `overflow-y-hidden`, not `overflow-hidden`: tailwind-merge files the two
 * under different keys, so `overflow-hidden` would leave the primitive's
 * `overflow-y-auto` standing and the whole sheet would keep scrolling behind
 * the pinned rows. Same failure mode as the `relative`/`absolute` note in
 * save-location-modal.tsx.
 */
export const SHEET_DETAILS_SHELL_CLASSNAME =
  "gap-0 overflow-y-hidden p-0 sm:p-0";

/** Pinned top row. `shrink-0` so a long title never steals the body's height. */
export const SHEET_HEADER_CLASSNAME =
  "relative z-10 shrink-0 border-b border-[color:var(--app-separator)] px-3 pb-2.5 pt-2.5";

/** The only scrolling element in the sheet. */
export const SHEET_BODY_CLASSNAME =
  "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] px-5 pb-5 pt-4";

/**
 * Pinned bottom row. Solid background, not the old `/95` -- a translucent
 * pinned bar reads as a patch stuck over the form rather than as the floor of
 * the sheet, and it is what let the last input show through the button.
 */
export const SHEET_FOOTER_CLASSNAME =
  "relative z-10 flex shrink-0 flex-col gap-2 border-t border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-default-solid)] px-5 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]";

/** Widths the sheet has to hold its shape at, smallest phone upward. */
export const SHEET_LAYOUT_WIDTHS = [320, 360, 375, 390, 430, 768] as const;
