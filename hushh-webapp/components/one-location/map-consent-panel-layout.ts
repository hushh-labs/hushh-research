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
