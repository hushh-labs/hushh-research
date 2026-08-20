/**
 * A primary action that cannot fire yet has to LOOK like it cannot fire.
 *
 * The shared button only dims to 50% opacity, and half-opacity accent over
 * these light sheets still reads as a live button — so "Create circle" and
 * "Select people" were reported as broken rather than understood as blocked.
 * This is the neutral disabled fill the Location hub's own primary CTAs
 * already use; nothing new is invented here.
 *
 * It lives in its own module because the add-people sheet exists TWICE — once
 * in the Circle detail flow and once in the Circle grow actions reached from
 * Check-In — and the two must not drift into looking different depending on
 * which entry point the same user took.
 */
export const BLOCKED_CTA =
  "disabled:bg-black/10 disabled:text-black/35 disabled:opacity-100 dark:disabled:bg-white/10 dark:disabled:text-white/35";
