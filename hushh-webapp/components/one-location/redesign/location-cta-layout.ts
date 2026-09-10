/**
 * Responsive geometry for the short action groups in One Location.
 *
 * These values are shared with the browser layout contract so the test
 * measures the exact classes rendered by the product.
 */

/** Keeps the two public-link duration choices and its CTA as one centred unit. */
export const PUBLIC_LINK_CONTROLS_CLASSNAME =
  "mx-auto w-full max-w-[280px] space-y-3";

export const PUBLIC_LINK_PRIMARY_CTA_CLASSNAME =
  "h-11 min-h-11 w-full rounded-[13px] bg-[color:var(--app-accent)] text-[16px] font-semibold leading-[21px] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90";

export const DURATION_EQUAL_BUTTONS_GROUP_CLASSNAME =
  "grid w-full grid-cols-2 gap-2";
export const DURATION_EQUAL_BUTTON_CLASSNAME = "min-h-11 min-w-0 px-3";

/** The final share action stays prominent without becoming a full-card slab. */
export const SHARE_CONFIRM_ACTIONS_CLASSNAME =
  "mx-auto w-full max-w-[320px] space-y-2.5";

export const SHARE_CONFIRM_PRIMARY_CTA_CLASSNAME =
  "h-12 min-h-12 w-full rounded-[14px] bg-[color:var(--app-accent)] text-[16px] font-semibold leading-[21px] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 disabled:bg-black/10 disabled:text-black/35 disabled:opacity-100 dark:disabled:bg-white/10 dark:disabled:text-white/35";

export const SHARE_CONFIRM_SECONDARY_CTA_CLASSNAME =
  "h-11 min-h-11 w-full rounded-[14px] bg-transparent text-[16px] font-medium leading-[21px] text-[color:var(--app-accent)] hover:bg-transparent";
