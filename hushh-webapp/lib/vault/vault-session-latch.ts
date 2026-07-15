/**
 * Module-level latch: once the vault unlocks in this JS session, route guards
 * should not flash the unlock dialog during client-side Next.js transitions.
 *
 * Cleared on explicit lock/logout. A full WebView reload resets this naturally.
 */

let sessionUnlockedUserId: string | null = null;

export function markSessionUnlocked(userId: string): void {
  const normalizedUserId = userId.trim();
  sessionUnlockedUserId = normalizedUserId || null;
}

export function resetSessionUnlocked(): void {
  sessionUnlockedUserId = null;
}

export function isSessionUnlockedOnce(userId: string | null | undefined): boolean {
  return Boolean(userId && sessionUnlockedUserId === userId);
}
