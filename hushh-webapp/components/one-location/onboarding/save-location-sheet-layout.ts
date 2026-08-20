/**
 * The measured geometry of the save-a-place surface, kept out of the component
 * so `e2e/save-location-sheet.layout.spec.ts` can compile and measure the REAL
 * class strings in a real browser.
 *
 * A JSDOM test proves the component still renders these classes; it cannot
 * prove what they do, because JSDOM performs no layout. Everything guarded here
 * is invisible to a class assertion.
 */

/**
 * THE WIDTH CONTRACT.
 *
 * Below 640px this surface is a bottom sheet and it spans the viewport. Above
 * it, it is a centred dialog and it does not.
 *
 * It used to carry an unconditional `mx-auto max-w-[420px]`. On a 375–430px
 * phone that is invisible, which is why it survived; between 421px and 639px --
 * a large phone in landscape, a small tablet, a browser window dragged narrow,
 * the split view an iPad runs the app in -- it painted a 420px card centred on
 * a wider screen with a dead grey strip down each side, so a *bottom sheet*
 * read as a rectangular pad floating above the app.
 *
 * Every other bottom sheet in this app already gates its width the other way
 * round: `sm:mx-auto sm:max-w-md` (portfolio-share-sheet, analysis-history-
 * dashboard), `sm:max-w-md` (KaiPreferencesSheet), or no width override at all
 * (profile-avatar-editor, nearby-check-in-sheet, named-circle-flows). Full
 * width below `sm`, constrained above it, is the house pattern; this surface
 * was the one place that inverted it.
 *
 * `max-h` accounts for the on-screen keyboard rather than ignoring it. The old
 * `max-h-[min(92dvh,760px)]` did not: the surface lifted by `--kb-height` and
 * kept its full height, so on a phone the top of the sheet -- the step rail,
 * the back button, the title -- was pushed off the top of the screen the
 * moment a field was focused.
 *
 * 92% of what is LEFT, not 92% of the screen minus the keyboard. The sheet is
 * already pinned above the keyboard by `bottom-[var(--kb-height)]`, so
 * `92dvh - kb` subtracts it a second time. On an iPhone SE with a 300px
 * keyboard that left 222px for a 61px header, a 36px minimum body and a 129px
 * footer -- and the pinned footer was pushed 3px past the bottom of its own
 * sheet, where the surface's `overflow-y-hidden` quietly clipped it. The
 * browser contract in `e2e/save-location-sheet.layout.spec.ts` measures this;
 * it is not a rounding allowance.
 */
export const SHEET_SURFACE_CLASSNAME =
  "w-full max-h-[calc((100dvh-var(--kb-height,0px))*0.92)]";

/**
 * The same surface above 640px, where it is a centred dialog and a constrained
 * width is the right answer.
 *
 * Deliberately carries NO `max-w-*`. The dialog primitive's own base string
 * already sets `sm:max-w-lg` (512px), and tailwind-merge does not treat a
 * PREFIXED `sm:max-w-lg` as conflicting with an unprefixed `max-w-[420px]` --
 * both survive the merge, and above 640px the prefixed one wins on
 * specificity. So the `max-w-[420px]` this surface used to carry was dead in
 * the only lane that renders it, and the dialog has always actually been
 * 512px. Naming a width here that the cascade ignores is worse than naming
 * none: the next person edits the number and nothing moves.
 *
 * The height is capped in `dvh` rather than left to the primitive so a tall
 * desktop window does not stretch the form to the full window.
 */
export const DIALOG_SURFACE_CLASSNAME =
  "mx-auto w-full max-h-[min(92dvh,760px)]";

/**
 * The width at which this surface stops being a bottom sheet and becomes a
 * centred dialog. The same 640px boundary Tailwind's `sm:` switches on -- one
 * number, so the presentation and the styling can never disagree.
 */
export const SHEET_PRESENTATION_QUERY = "(max-width: 639.98px)";

/**
 * Sheet shell while the details pane is on screen. Turns the surface from "one
 * long scroll box with padding" into a fixed frame whose middle row scrolls.
 *
 * `overflow-y-hidden`, not `overflow-hidden`: tailwind-merge files the two
 * under different keys, so `overflow-hidden` would leave the primitive's
 * `overflow-y-auto` standing and the whole sheet would keep scrolling behind
 * the pinned rows.
 */
export const SHEET_DETAILS_SHELL_CLASSNAME =
  "gap-0 overflow-y-hidden p-0 sm:p-0";

/**
 * The shell for the panes that are NOT the details form -- the map and the
 * summary. They are short enough to be their own scroll box, so they keep the
 * plain padded surface.
 *
 * The bottom padding is the home indicator, INSIDE the sheet. The sheet itself
 * stays flush with the bottom edge of the screen; an outer gap would put a
 * strip of wallpaper under a surface that is supposed to be attached to it.
 */
export const SHEET_PLAIN_SHELL_CLASSNAME =
  "gap-5 overflow-y-auto p-5 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] sm:p-6 sm:pb-6";

/** Pinned top row. `shrink-0` so a long title never steals the body's height. */
export const SHEET_HEADER_CLASSNAME =
  "relative z-10 shrink-0 border-b border-[color:var(--app-separator)] px-3 pb-2.5 pt-2.5";

/** The only scrolling element in the sheet. */
export const SHEET_BODY_CLASSNAME =
  "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] px-5 pb-5 pt-4";

/**
 * Pinned bottom row. Solid background, not a translucent one -- a translucent
 * pinned bar reads as a patch stuck over the form rather than as the floor of
 * the sheet, and it is what lets the last input show through the button.
 *
 * The home-indicator inset lives in this padding. That is the whole of the
 * safe-area handling for this surface: the sheet reaches the bottom edge, and
 * the last thing you can press sits above the indicator.
 */
export const SHEET_FOOTER_CLASSNAME =
  "relative z-10 flex shrink-0 flex-col gap-2 border-t border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-default-solid)] px-5 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]";

/**
 * THE STEP INDICATOR SLOT.
 *
 * One slot, one height, rendered in the pinned-header position by every pane.
 * The rail used to be emitted two different ways -- absent from the summary
 * pane, and at the BOTTOM of the map pane, under the buttons -- so it appeared
 * to move as a person advanced through two steps.
 *
 * 18px is load-bearing: the rail doubles as the iOS grabber and as the sheet's
 * drag surface, and a taller one adds a third stacked header row that the
 * layout spec measures at six widths.
 */
export const SHEET_INDICATOR_SLOT_CLASSNAME =
  "flex h-[18px] shrink-0 items-center justify-center";

/**
 * Reached -- the step you are on, or one already finished. `--app-accent`
 * measures 4.02:1 on the light sheet (#ffffff) and 3.47:1 on the dark one
 * (#2c2c2e).
 */
export const STEP_DOT_REACHED_CLASSNAME = "bg-[color:var(--app-accent)]";

/**
 * Not reached yet.
 *
 * This was `--app-neutral-fill-strong`, a translucent fill meant for large
 * shapes, which composites to #E4E4E6 on the light sheet (1.27:1) and #47474C
 * on the dark one (1.51:1) -- well under the 3:1 WCAG 2.2 SC 1.4.11 asks of a
 * control that carries state. #8E8E93 is the iOS secondary grey and the single
 * value that clears the floor on BOTH surfaces (3.26:1 / 4.27:1).
 */
export const STEP_DOT_UPCOMING_CLASSNAME = "bg-[#8E8E93]";

/** The floor a state-carrying control has to clear against its surface. */
export const STEP_DOT_MIN_CONTRAST = 3;

/**
 * A field label and the badge that says whether it is needed, as one row.
 *
 * Exported for the same reason as the rows above: this is the only place on
 * the sheet where a label shares its line with something else, so it is the
 * only place a narrow phone can push a word off the edge. JSDOM can prove the
 * badge renders; only a browser can prove it still fits beside "House or flat"
 * at 320px.
 */
export const ADDRESS_LABEL_ROW_CLASSNAME = "mb-1 flex items-center gap-1.5";

/** The badge itself. `shrink-0` is what keeps it a pill rather than a sliver. */
export const REQUIRED_BADGE_CLASSNAME =
  "shrink-0 rounded-full bg-[color:var(--app-destructive)]/12 px-1.5 py-px text-[11px] font-semibold uppercase leading-[16px] tracking-[0.02em] text-[color:var(--app-destructive)]";

/**
 * The Optional counterpart, on House or flat and Landmark. A single sentence
 * once said this for the whole group, but a field styled exactly like the
 * required Address box above it reads as required regardless of a caption a
 * screen further up -- people go by the shape of the box, not by a sentence
 * they have already scrolled past. Outlined rather than filled, so it reads as
 * the calmer sibling of the solid Required pill rather than an equally loud
 * claim.
 */
export const OPTIONAL_BADGE_CLASSNAME =
  "shrink-0 rounded-full border border-border/70 px-1.5 py-px text-[11px] font-semibold uppercase leading-[16px] tracking-[0.02em] text-muted-foreground";

/**
 * The map on step one.
 *
 * `dvh`, not `vh`: on mobile Safari `vh` is measured against the tallest
 * viewport, so a `56vh` map is taller than the space actually on screen while
 * the toolbar is showing.
 *
 * Clamped rather than a flat fraction because the failure is at both ends. At
 * `min(56vh,420px)` an iPhone SE gave the map 318 of its 568 points and pushed
 * Confirm and Skip below the fold, on the one screen whose entire job is
 * "look at this, then press Confirm". A 15 Pro Max, meanwhile, does not want
 * every element stretched merely because the space exists -- 34dvh of 932 is
 * 317px, a map, not a wall.
 *
 * `shrink-0` is not decoration. The map sits in a `flex flex-col` pane inside a
 * scrolling sheet, and its only child fills it with `h-full` -- so its
 * min-content height is 0. Without this, a viewport short enough to overflow
 * the pane resolves the overflow by collapsing the map to nothing, and the
 * screen whose entire job is "look at this map" renders a hairline. The
 * browser contract in `e2e/save-location-sheet.layout.spec.ts` measured
 * exactly that before this was added.
 */
export const PICKER_MAP_HEIGHT_CLASSNAME =
  "h-[clamp(160px,34dvh,340px)] shrink-0";

/** Widths the surface has to hold its shape at, smallest phone upward. */
export const SHEET_LAYOUT_WIDTHS = [320, 360, 375, 390, 430, 768] as const;

/**
 * Widths where this surface is a BOTTOM SHEET and must therefore span the
 * viewport. 430 is the iPhone 15 Pro Max; 480, 540 and 639 are the band the
 * old unconditional `max-w-[420px]` turned into a floating pad.
 */
export const SHEET_FULL_BLEED_WIDTHS = [320, 360, 375, 390, 430, 480, 540, 639] as const;
