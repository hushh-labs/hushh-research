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
export const LIVE_SHARE_CARD_CLASSNAME =
  "!overflow-hidden !rounded-[18px] !border-0 bg-[color:var(--app-primary-surface)] p-4 !shadow-none";

/**
 * Badge on the left, the one action on the right, sharing a centreline — the
 * small badge top-aligned against a 44px button reads as a misalignment.
 */
export const LIVE_SHARE_HEADER_CLASSNAME =
  "flex items-center justify-between gap-3";

/**
 * 44px, the comfortable touch target — this is the control that stops sharing,
 * so it is not allowed to be the 36px the denser list rows use.
 */
export const LIVE_SHARE_ACTION_CLASSNAME =
  "h-11 shrink-0 rounded-full px-4 text-[15px] font-semibold leading-5";

/**
 * A name is unbounded. It wraps rather than truncating: "Sharing with Priyan…"
 * hides the one fact the card exists to state.
 */
export const LIVE_SHARE_TITLE_CLASSNAME =
  "text-[17px] font-semibold leading-[22px] text-foreground [overflow-wrap:anywhere]";

/** Compact metadata row: the timer is information, not the whole screen. */
export const LIVE_SHARE_CLOCK_ROW_CLASSNAME =
  "mt-0.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]";

/** `tabular-nums` keeps the width fixed as the digits change, so it cannot jitter. */
export const LIVE_SHARE_CLOCK_CLASSNAME =
  "font-medium text-[color:var(--app-primary-label)] tabular-nums";

export const LIVE_SHARE_PROGRESS_TRACK_CLASSNAME =
  "mt-3 h-1 w-full overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.12]";

export const LIVE_SHARE_PROGRESS_FILL_CLASSNAME =
  "h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-linear";

export const LIVE_SHARE_FOOTER_CLASSNAME = "min-w-0 [overflow-wrap:anywhere]";

/**
 * The live-share actions stay compact and left aligned once both labels fit.
 * At the narrowest supported phone width they stack so neither label wraps and
 * both controls retain a comfortable touch target.
 */
export const LIVE_SHARE_FOOTER_ROW_CLASSNAME =
  "mt-4 flex flex-col items-stretch gap-2.5 min-[360px]:flex-row min-[360px]:items-center sm:gap-3";

/** Primary CTA: full width only when the 320px layout needs to stack. */
export const LIVE_SHARE_PRIMARY_ACTION_CLASSNAME =
  "h-11 min-h-11 w-full rounded-full bg-[color:var(--app-accent)] px-4 font-[family-name:var(--font-app-body)] text-[15px] font-semibold leading-5 tracking-[-0.01em] text-white transition-[background-color,transform] hover:bg-[color:var(--app-accent)]/90 active:scale-[0.98] min-[360px]:w-auto sm:px-5";

/** Secondary CTA follows the same responsive width without competing visually. */
export const LIVE_SHARE_SECONDARY_ACTION_CLASSNAME =
  "w-full justify-center bg-[color:var(--app-neutral-fill)] hover:bg-[color:var(--app-neutral-fill-strong)] min-[360px]:w-auto";
