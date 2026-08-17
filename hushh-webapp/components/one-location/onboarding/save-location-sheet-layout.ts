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

/**
 * THE STEP INDICATOR SLOT (#5396).
 *
 * One slot, one height, rendered in the pinned-header position by every pane
 * of the sheet. The rail used to be emitted three different ways — absent on
 * the summary pane, 44px tall at the BOTTOM of the map pane, 18px tall at the
 * TOP of the details pane — so it appeared to move and resize as a person
 * advanced through two steps.
 *
 * 18px is load-bearing: the rail doubles as the iOS grabber, and a taller one
 * reintroduces the third stacked header row that the layout spec measures at
 * six widths.
 */
export const SHEET_INDICATOR_SLOT_CLASSNAME =
  "flex h-[18px] shrink-0 items-center justify-center";

/**
 * Reached — the step you are on, or one already finished. `--app-accent`
 * measures 4.02:1 on the light sheet (#ffffff) and 3.47:1 on the dark one
 * (#2c2c2e).
 */
export const STEP_DOT_REACHED_CLASSNAME = "bg-[color:var(--app-accent)]";

/**
 * Not reached yet.
 *
 * This was `--app-neutral-fill-strong`, a translucent fill meant for large
 * shapes, which composites to #E4E4E6 on the light sheet (1.27:1) and
 * #47474C on the dark one (1.51:1) — well under the 3:1 WCAG 2.2 SC 1.4.11
 * asks of a control that carries state. #8E8E93 is the iOS secondary grey and
 * the single value that clears the floor on BOTH surfaces (3.26:1 / 4.27:1),
 * so upcoming steps read the same in either theme rather than needing a pair
 * that can drift apart.
 *
 * Exported so `e2e/save-location-sheet.layout.spec.ts` measures the same
 * string the component paints — jsdom performs no layout and cannot prove a
 * colour, per the repo's own rule about that.
 */
export const STEP_DOT_UPCOMING_CLASSNAME = "bg-[#8E8E93]";

/** The floor a state-carrying control has to clear against its surface. */
export const STEP_DOT_MIN_CONTRAST = 3;

/**
 * The Address label and its "Required" badge, as one row.
 *
 * Exported for the same reason as the three above: the badge is the only place
 * on this sheet where a label shares its line with something else, so it is
 * the only place where a narrow phone can push a word off the edge. A JSDOM
 * test can prove the badge is rendered; only a browser can prove it still fits
 * beside the word "Address" at 320px.
 */
export const ADDRESS_LABEL_ROW_CLASSNAME = "mb-1 flex items-center gap-1.5";

/** The badge itself. `shrink-0` is what keeps it a pill rather than a sliver. */
export const REQUIRED_BADGE_CLASSNAME =
  "shrink-0 rounded-full bg-[color:var(--app-destructive)]/12 px-1.5 py-px text-[11px] font-semibold uppercase leading-[16px] tracking-[0.02em] text-[color:var(--app-destructive)]";

/**
 * The row that opens the optional door details. A control, so it owes the
 * platform's 44px minimum -- and `min-h-11` rather than a fixed height,
 * because its label wraps to two lines under a large text setting.
 */
export const DOOR_DETAILS_TOGGLE_CLASSNAME =
  "press-scale flex min-h-11 w-full items-center justify-between gap-2 rounded-[14px] border border-border/70 bg-[color:var(--app-card-surface-default-solid)] px-3.5 py-2.5 text-left transition-colors hover:bg-foreground/[0.03] disabled:opacity-45";

/** Widths the sheet has to hold its shape at, smallest phone upward. */
export const SHEET_LAYOUT_WIDTHS = [320, 360, 375, 390, 430, 768] as const;
