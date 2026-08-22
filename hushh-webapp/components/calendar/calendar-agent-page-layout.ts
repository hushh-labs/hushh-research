/**
 * Layout contract for the Calendar agent / setup screen.
 *
 * Lives in its own module so the browser layout spec can import the exact
 * string the screen renders, without pulling React and the whole page in. The
 * JSDOM suite proves the component still renders these classes; the layout spec
 * proves what they DO in the real Tailwind cascade, which JSDOM cannot see
 * because it performs no layout.
 *
 * The screen previously pinned itself with
 *
 *   fixed inset-x-0 top-[64px] bottom-[115px] ... justify-center overflow-hidden
 *
 * which gave it a viewport-derived height, no scroll, and shrinkable children.
 * On any viewport shorter than the card, the card collapsed to a sliver and the
 * Connect button clipped straight through it. The hardcoded 64/115 also ignored
 * `--top-shell-reserved-height` and `--app-bottom-inset`, so it could not track
 * the real chrome or a native safe area.
 *
 * Normal flow instead, matching every sibling capability setup screen: the page
 * scrolls, so a short viewport costs a scroll rather than the content.
 */
export const CALENDAR_SETUP_SHELL_CLASSNAME =
  "motion-step-enter space-y-4 pb-[calc(var(--app-bottom-inset)+1rem)]";

/** Header and content share one measure so the card never outgrows the title. */
export const CALENDAR_SETUP_REGION_CLASSNAME = "w-full max-w-md mx-auto";
