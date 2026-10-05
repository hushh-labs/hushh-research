/**
 * Responsive geometry for the short action groups in One Location.
 *
 * These values are shared with the browser layout contract so the test
 * measures the exact classes rendered by the product.
 */

/** Keeps the public-link controls together and aligned to the card's content edge. */
export const PUBLIC_LINK_CONTROLS_CLASSNAME =
  "w-full space-y-3 sm:max-w-[320px]";

/** Gives the create-link form one centered iOS control measure. */
export const PUBLIC_LINK_CREATE_FORM_CLASSNAME =
  "mx-auto flex w-full max-w-[244px] flex-col items-stretch space-y-3 pb-4 pt-2";

export const PUBLIC_LINK_DURATION_GROUP_CLASSNAME = "w-full";

export const PUBLIC_LINK_PRIMARY_CTA_CLASSNAME =
  "ui-text-button-label h-[50px] min-h-[50px] w-full rounded-full px-6 bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90";

export const DURATION_EQUAL_BUTTONS_GROUP_CLASSNAME =
  "grid w-full grid-cols-3 gap-2";
export const DURATION_EQUAL_BUTTON_CLASSNAME = "min-h-11 min-w-0 px-3";

/** The final share action stays prominent without becoming a full-card slab. */
export const SHARE_CONFIRM_ACTIONS_CLASSNAME =
  "mx-auto w-full max-w-[244px] space-y-2.5";

export const SHARE_CONFIRM_PRIMARY_CTA_CLASSNAME =
  "ui-text-button-label h-[50px] min-h-[50px] w-full rounded-full bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 disabled:bg-black/10 disabled:text-black/35 disabled:opacity-100 dark:disabled:bg-white/10 dark:disabled:text-white/35";

export const SHARE_CONFIRM_SECONDARY_CTA_CLASSNAME =
  "ui-text-button-label h-11 min-h-11 w-full rounded-[14px] bg-transparent text-[color:var(--app-accent)] hover:bg-transparent";
