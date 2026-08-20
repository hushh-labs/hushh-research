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
export const LIVE_SHARE_CARD_CLASSNAME = "overflow-hidden p-4";

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
  "mt-3 text-[17px] font-semibold leading-[22px] text-foreground [overflow-wrap:anywhere]";

/** Wraps so the unit word drops below the clock instead of pushing it out. */
export const LIVE_SHARE_CLOCK_ROW_CLASSNAME =
  "mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5";

/** `tabular-nums` keeps the width fixed as the digits change, so it cannot jitter. */
export const LIVE_SHARE_CLOCK_CLASSNAME =
  "text-[34px] font-semibold leading-[40px] tracking-[-0.5px] text-foreground tabular-nums";

export const LIVE_SHARE_PROGRESS_TRACK_CLASSNAME =
  "mt-3 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.12]";

export const LIVE_SHARE_PROGRESS_FILL_CLASSNAME =
  "h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-linear";

export const LIVE_SHARE_FOOTER_CLASSNAME = "min-w-0 [overflow-wrap:anywhere]";

/**
 * End time on the left, "Change time" on the right — the action sits with the
 * fact it edits.
 *
 * Both pills do fit in the header at 320px; measured, not assumed. They are
 * split up for what they mean, not for room. Stop ends someone's access and is
 * the only destructive control on this card: pairing it with a benign action
 * in one right-aligned cluster makes them look like a matched set, and the tap
 * you do not want to make by accident should not sit inside a toolbar.
 * "Change time" beside "Ends 6:03 PM" is the fact and its edit, together.
 *
 * `flex-wrap` is the safety margin down here: "Ends 11:30 PM" beside a 44px
 * pill is close to the edge on the narrowest phone, and dropping the action to
 * its own line is the right way to run out of room.
 */
export const LIVE_SHARE_FOOTER_ROW_CLASSNAME =
  "mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1";
