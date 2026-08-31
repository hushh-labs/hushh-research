/**
 * The check-in panel's layout contract, in one place.
 *
 * These strings are shared between the sheet that ships them and the browser
 * spec that measures them (`e2e/one-location-check-in-panel.layout.spec.ts`),
 * which is the only way the measurement can be trusted: a spec that hand-copies
 * a className measures a replica, and keeps passing after the real component
 * has drifted away from it. Same pattern as `circle-name-row-layout` and
 * `connect-search-layout`.
 *
 * PRESENTATION ONLY. No React, no state, no data access. Nothing here decides
 * what the panel does — only how wide, how tall, and how it behaves when a
 * place name is longer than the room it has.
 */

import type { ButtonProps } from "@/components/ui/button";

/**
 * Ending a check-in is a normal, reversible lifecycle step.
 *
 * The presence was always going to end on its own timer; checking out early
 * flips its status, destroys the anchor key, and can be redone in three taps.
 * `destructive` is this product's signal for SOS, delete, revoke and stop
 * sharing — spending it here would both dilute that signal and make the calm
 * "you are checked in" state read as an alarm.
 */
export const CHECK_OUT_BUTTON_VARIANT: ButtonProps["variant"] = "secondary";

/**
 * The desktop side rail, in rem.
 *
 * Check-in is a question about the map — "which of these places are you at?" —
 * so the map stays the dominant layer and the panel is the overlay that
 * completes the action, not the other way round. 26rem is wide enough for a
 * place name plus its distance without truncating the common case, and narrow
 * enough that the map keeps the majority of any desktop viewport.
 */
export const CHECK_IN_PANEL_DESKTOP_WIDTH_REM = 26;

/**
 * The category chip scroller.
 *
 * Horizontal scroll, never wrap: eight chips wrapping to three rows at 320px
 * would push the place list below the fold on an iPhone SE, and the list is
 * the thing being chosen from. The scrollbar is hidden until hover so a phone
 * never renders a track it cannot use.
 */
export const CHECK_IN_CATEGORY_ROW_CLASSNAME = [
  "mt-3 flex gap-2 overflow-x-auto pb-1",
  "[scrollbar-width:none] hover:[scrollbar-width:thin]",
  "[&::-webkit-scrollbar]:hidden hover:[&::-webkit-scrollbar]:block",
  "[&::-webkit-scrollbar]:h-1.5",
  "[&::-webkit-scrollbar-track]:bg-transparent",
  "[&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/30",
].join(" ");

/**
 * A place row.
 *
 * `items-center` with a truncating middle column and two `shrink-0` ends: the
 * pin and the distance keep their room, and a long venue name gives up its own
 * width rather than pushing the distance off the row.
 */
export const CHECK_IN_PLACE_ROW_CLASSNAME =
  "flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors";

export const CHECK_IN_PLACE_ROW_OFF_CLASSNAME =
  "border-border/60 bg-muted/50 hover:bg-muted";

export const CHECK_IN_PLACE_ROW_ON_CLASSNAME =
  "border-[var(--app-accent)] bg-[var(--app-accent-surface)]";

/** The venue name. One line, always — a wrapped name doubles every row. */
export const CHECK_IN_PLACE_NAME_CLASSNAME =
  "block truncate text-sm font-semibold leading-5";

/** The single supporting line under it: what kind of place this is. */
export const CHECK_IN_PLACE_META_CLASSNAME =
  "mt-0.5 block truncate text-xs leading-4 text-muted-foreground";

/** The distance column. Never wraps: "13 m" splitting across two lines is
 *  the one thing that can make a row taller than its content. */
export const CHECK_IN_PLACE_DISTANCE_CLASSNAME =
  "shrink-0 whitespace-nowrap text-xs text-muted-foreground";

/* ------------------------------------------------------------------ */
/* The rating step, after checkout                                     */
/* ------------------------------------------------------------------ */

/**
 * These live here, next to the rest of the panel's geometry, for the reason
 * this module already exists: `e2e/one-location-check-in-panel.layout.spec.ts`
 * measures the class strings the screen actually ships, and a fixture that
 * hand-copies them stops proving anything the first time one changes.
 *
 * Every constant added here must also be added to that spec's `CANDIDATES`
 * array, or Tailwind compiles the fixture stylesheet without it and the
 * measurements pass against an unstyled box.
 */

/** Five 44px targets, spread so the gaps absorb the width rather than the
 *  targets shrinking. 5 x 44 = 220px fits inside 320px minus the panel's own
 *  padding with room to spare. */
export const CHECK_IN_STAR_ROW_CLASSNAME =
  "flex w-full items-center justify-between";

/** The tap target is the radio item, not the glyph. 44px is the platform
 *  minimum and matches the rest of this panel. */
export const CHECK_IN_STAR_TARGET_CLASSNAME =
  "grid h-11 w-11 place-items-center rounded-full outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Filled stars take the accent, not amber.
 *
 * `semantic-roles.ts` defines the warning family as "needs a look soon:
 * pending, awaiting review, expiring". Painting a five-star scale from it
 * misuses the one layer that exists to stop colour drift, and fill-versus-
 * outline is already carrying the signal -- colour here is secondary, so it
 * follows the reader's accent preference like every other affordance.
 */
export const CHECK_IN_STAR_GLYPH_ON_CLASSNAME =
  "h-7 w-7 fill-current text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]";

export const CHECK_IN_STAR_GLYPH_OFF_CLASSNAME = "h-7 w-7 text-muted-foreground/50";

/**
 * The composer slot holds the helper line before a star is chosen and the note
 * field after, at ONE height.
 *
 * The map puts a `ResizeObserver` on this sheet and republishes
 * `map.setPadding()` on every height change, so a pane that grows as you
 * interact settles the camera three times for one interaction. Reserving the
 * height settles it once, on arrival, exactly as the pane does today.
 *
 * `flex h-[76px]`, not `min-h-[76px]`. A textarea is inline-block, so a plain
 * block wrapper adds the line box's descender space underneath it and the slot
 * measured 82px with the field and 76px without -- a 6px camera nudge on the
 * first tap. The layout spec caught it, which is what it is for.
 */
export const CHECK_IN_RATING_COMPOSER_CLASSNAME = "flex h-[76px] flex-col";

/**
 * `field-sizing-fixed` is the single most load-bearing class in the rating
 * step. `components/ui/textarea.tsx` ships `field-sizing-content`, which grows
 * the box as you type -- which grows the sheet, which moves the map, every few
 * characters. `text-base` stays: 16px is what stops iOS Safari zooming the
 * viewport on focus.
 */
export const CHECK_IN_NOTE_TEXTAREA_CLASSNAME =
  "h-full min-h-0 w-full resize-none field-sizing-fixed text-base md:text-base";

export const CHECK_IN_NOTE_MAX_LENGTH = 280;

/** Show the counter only near the cap. A counter from character zero reads as
 *  a word-count assignment on what is meant to be a note to yourself. */
export const CHECK_IN_NOTE_COUNTER_VISIBLE_AT = 240;
