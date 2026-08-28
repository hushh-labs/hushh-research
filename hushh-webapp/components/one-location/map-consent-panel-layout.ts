/**
 * Layout contract for the Google Maps renderer-consent panel on Your Map.
 *
 * These class strings live here rather than inline so the component and the
 * real-browser layout spec read one source. The geometry is asserted twice,
 * because neither check alone is sufficient -- JSDOM proves the classes are
 * rendered, `e2e/one-location-map-consent-panel.layout.spec.ts` proves what
 * they do.
 *
 * What changed and why:
 *
 * The panel used to float `max(1rem, env(safe-area-inset-bottom))` above the
 * bottom edge with a border on all four sides and `shadow-2xl`. On a phone
 * that leaves a strip of live map under a full-bleed-width card, which reads as
 * a pad that has come loose rather than the screen's content surface -- and it
 * spent the safe-area inset on a gap instead of on the button that has to clear
 * the home indicator.
 *
 * It is now anchored to the bottom edge with a rounded top and a single top
 * border, the shape the final onboarding screen already uses
 * (`onboarding/ready-panel-layout.ts`). The safe-area inset moved inside, as
 * bottom padding, so the primary action clears the home indicator without a
 * gap under the card.
 */

/**
 * The map surface, and the renderer inside it.
 *
 * Exported so the layout spec can measure the same strings the component
 * renders, and so the claim "the container was never the problem" is executable
 * rather than a comment. The blank strip above the map was a camera, not a box
 * -- see `lib/one-location/map-world-view.ts`.
 */
export const MAP_SURFACE_CLASSNAME =
  "one-location-map relative h-[100dvh] w-full overflow-hidden bg-muted";

/** The renderer element. Full-bleed under every floating control. */
export const MAP_RENDERER_CLASSNAME = "absolute inset-0 block h-full w-full";

/**
 * Bottom-anchored sheet on phones; a centred dialog from `md:` up.
 *
 * `md:w-[430px]` matches the onboarding ready panel. The previous
 * `md:w-[min(52rem,…)]` was an 832 px card for one title, one line and one
 * button.
 */
export const MAP_CONSENT_PANEL_CLASSNAME =
  "absolute inset-x-0 bottom-0 z-20 rounded-t-[28px] border-t border-border/60 bg-background/95 px-5 pt-5 shadow-[0_-8px_24px_rgba(24,57,91,0.10)] backdrop-blur-xl md:inset-x-auto md:bottom-6 md:left-1/2 md:w-[430px] md:max-w-[calc(100%-4rem)] md:-translate-x-1/2 md:rounded-[30px] md:border md:shadow-[0_24px_80px_rgba(24,57,91,0.22)]";

/**
 * Bottom padding for the panel, as an inline style.
 *
 * `env()` inside an arbitrary Tailwind value is brittle across the versions
 * this repo has shipped, and the layout spec has to read one deterministic
 * value. `1.25rem` matches the `px-5`/`pt-5` the panel already uses.
 */
export const MAP_CONSENT_PANEL_BOTTOM_PADDING =
  "calc(1.25rem + env(safe-area-inset-bottom))";

/** Tailwind's `md:` breakpoint -- where the sheet becomes a centred dialog. */
export const MAP_CONSENT_PANEL_DIALOG_MIN_WIDTH_PX = 768;

/** The panel's fixed width once it is a dialog (`md:w-[430px]`). */
export const MAP_CONSENT_PANEL_DIALOG_WIDTH_PX = 430;

/**
 * The pin and the title, on one line.
 *
 * Reported on the first-run view: the icon sat on its own line above the
 * heading (`<MapPin class="h-6 w-6">` then `<h1 class="mt-3 …">`), which left a
 * small thin glyph stranded in the panel's top-left corner with 12px of empty
 * sheet under it and the heading below that. Two stacked leading elements for
 * one four-word title read as a layout that lost a row rather than a header.
 *
 * They are one row now. `items-center` rather than `items-baseline`: the pin is
 * a symbol, not a letterform, and baseline-aligning a glyph whose visual mass
 * hangs below its own baseline pushed it low against the cap line.
 *
 * `mt-3` is gone with the stack, so the supporting line's `mt-2` is now
 * measured from the header row. The panel is sized by its content and is
 * therefore about a row shorter, which the layout spec spends on map.
 *
 * Split into three exported strings rather than one because the icon and the
 * heading also carry theme classes the fixture must not compile -- see the
 * note at the top of this file.
 */
export const MAP_CONSENT_HEADER_CLASSNAME = "flex items-center gap-2.5";

/** The pin. `shrink-0` so a narrow sheet squeezes the title, never the glyph. */
export const MAP_CONSENT_ICON_CLASSNAME = "h-6 w-6 shrink-0";

/**
 * The heading.
 *
 * `mt-3` removed. `text-xl font-semibold` is kept verbatim and is deliberately
 * inert in the app: `app/globals.css` locks every `h1` to the foundation
 * title-1 token with `!important`, so this pair only has an effect in the
 * layout fixture, which compiles utilities without the app's base layer. It
 * stays so the fixture measures a heading of a plausible size instead of a UA
 * default, and so removing the global lock later does not silently drop this
 * screen's heading to body copy.
 */
export const MAP_CONSENT_TITLE_CLASSNAME = "text-xl font-semibold";

/** The supporting line, still one rendered line at 320px. */
export const MAP_CONSENT_SUPPORTING_CLASSNAME = "mt-2 text-sm leading-6";

/**
 * The only two strings under the title.
 *
 * Exported so the copy contract test asserts the shipped constant rather than a
 * second copy of the words. The paragraph these replaced explained how Google
 * Maps is fed and what Nearby Check-In does; Location Settings already states
 * the Check-In disclosure, and the renderer detail is not something a person
 * standing on this screen can act on.
 */
export const MAP_CONSENT_TITLE = "Your Map";
export const MAP_CONSENT_SUPPORTING_LINE = "Private until you share.";
