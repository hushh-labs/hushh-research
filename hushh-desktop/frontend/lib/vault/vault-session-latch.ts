/**
 * Module-level latch: once the vault unlocks in this JS session, route guards
 * should not flash the unlock dialog during client-side Next.js transitions.
 *
 * Cleared on explicit lock/logout. A full WebView reload resets this naturally.
 */

let sessionUnlockedOnce = false;

export function markSessionUnlocked(): void {
  sessionUnlockedOnce = true;
}

export function resetSessionUnlocked(): void {
  sessionUnlockedOnce = false;
}

export function isSessionUnlockedOnce(): boolean {
  return sessionUnlockedOnce;
}
