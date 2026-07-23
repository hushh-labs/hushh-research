"use client";

/**
 * Deliberate-entry intent for the One setup surface.
 *
 * The onboarding guard forces the setup hub ONCE during first onboarding. After
 * the user dismisses onboarding, `/one/setup` must be reachable ONLY by an
 * explicit in-app action (Profile → "Set Up One"), never by the browser/OS back
 * button, a stale history entry, or a direct URL.
 *
 * This flag records "the user just deliberately opened setup". It is:
 *  - in-memory only (module scope) — a page reload or a fresh tab does NOT count
 *    as deliberate, so history/back navigation can never satisfy it;
 *  - set on the deliberate tap (Profile → "Set Up One");
 *  - read by the onboarding guard to admit a dismissed user onto a setup surface;
 *  - cleared by the guard the moment the user is on any non-setup surface, so it
 *    only ever covers the active deliberate visit.
 */
let deliberateSetupEntry = false;

/** Record that the user is deliberately opening the setup surface. */
export function markSetupIntent(): void {
  deliberateSetupEntry = true;
}

/** Forget any deliberate-entry intent (called when leaving the setup surface). */
export function clearSetupIntent(): void {
  deliberateSetupEntry = false;
}

/** Whether the current arrival at a setup surface is a deliberate in-app open. */
export function hasSetupIntent(): boolean {
  return deliberateSetupEntry;
}
