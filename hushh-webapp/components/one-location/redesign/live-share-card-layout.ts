/**
 * Layout-critical class strings for the live share status card.
 *
 * Split out of the component for one reason: the Playwright layout contract
 * imports these directly and measures what they do in a real browser. The e2e
 * tsconfig carries no path aliases, so this module deliberately imports
 * nothing — keep it that way, or the contract stops compiling.
 *
 * A JSDOM test can prove the card renders these classes. Only a browser can
 * prove they keep a 34px countdown, a person's full name, and a 44px Stop
 * control inside a 320px phone without clipping any of them.
 */

/** Card body. `overflow-hidden` clips the progress fill to the rounded corner. */
export const LIVE_SHARE_CARD_CLASSNAME = "overflow-hidden p-4 sm:p-5";

/**
 * Badge on the left, the one action on the right, sharing a centreline — the
 * small badge top-aligned against a 44px button reads as a misalignment.
 */
export const LIVE_SHARE_HEADER_CLASSNAME =
  "-mt-1 flex items-center justify-between gap-3";

/**
 * 44px, the comfortable touch target — this is the control that stops sharing,
 * so it is not allowed to be the 36px the denser list rows use.
 */
export const LIVE_SHARE_ACTION_CLASSNAME =
  "h-11 shrink-0 rounded-full px-4 text-[15px] font-medium";

/**
 * A name is unbounded. It wraps rather than truncating: "Sharing with Priyan…"
 * hides the one fact the card exists to state.
 */
export const LIVE_SHARE_TITLE_CLASSNAME =
  "text-[17px] font-semibold leading-[22px] text-foreground [overflow-wrap:anywhere]";

/** Compact metadata row: the timer is information, not the whole screen. */
export const LIVE_SHARE_CLOCK_ROW_CLASSNAME =
  "mt-0.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[15px] leading-5 text-[color:var(--app-secondary-label)]";

/** `tabular-nums` keeps the width fixed as the digits change, so it cannot jitter. */
export const LIVE_SHARE_CLOCK_CLASSNAME =
  "font-medium text-[color:var(--app-primary-label)] tabular-nums";

export const LIVE_SHARE_PROGRESS_TRACK_CLASSNAME =
  "mt-3 h-1 w-full overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.12]";

export const LIVE_SHARE_PROGRESS_FILL_CLASSNAME =
  "h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-linear";

export const LIVE_SHARE_FOOTER_CLASSNAME = "min-w-0 [overflow-wrap:anywhere]";

/**
 * The secondary action sits under the primary share CTA so the Now card keeps
 * one obvious next action and one quieter editing affordance.
 */
export const LIVE_SHARE_FOOTER_ROW_CLASSNAME =
  "mt-3 flex flex-wrap items-center justify-end gap-x-3 gap-y-1";
