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
 * Normal flow instead, and `min-h` rather than a height. That one word is the
 * whole difference: a `min-height` container GROWS past its floor, so when the
 * card is taller than the space the page simply gets longer and scrolls, and
 * `justify-center` quietly stops applying because there is no free space left to
 * distribute. On a screen with room, the card is centred as it always was.
 *
 * The same idiom the RIA setup screen already uses
 * (`app/one/setup/ria/ria-onboarding-setup-client.tsx`).
 *
 * `justify-center` is only safe here BECAUSE the height is a floor. Combined
 * with a fixed height it centres the overflow too, putting the top of the card
 * above the container's top edge where no scroll can reach it — which is the
 * bug this screen shipped with. Do not reintroduce a hard height here.
 */
export const CALENDAR_SETUP_SHELL_CLASSNAME =
  "motion-step-enter flex h-[calc(100dvh-var(--top-shell-reserved-height,4rem)-var(--app-bottom-inset,2rem))] max-h-[calc(100dvh-var(--top-shell-reserved-height,4rem)-var(--app-bottom-inset,2rem))] w-full flex-col items-center justify-center gap-4 overflow-hidden py-2";

/** Header and content share one measure so the card never outgrows the title. */
export const CALENDAR_SETUP_REGION_CLASSNAME = "w-full max-w-md mx-auto";
