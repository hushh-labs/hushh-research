/**
 * Whether Plaid's native SDK is presenting Link right now.
 *
 * LinkKit 7 finishes a bank's OAuth round trip inside the session it opened;
 * it has no resume call, so the app must stay out of that leg. When the bank
 * hands back through the Universal Link, the app is also told about the
 * Plaid return URL, and following it would open Link a second time (LinkKit
 * refuses with ALREADY_OPEN, or starts over) and unmount the screen waiting
 * for the result. The deep-link router asks this before following it.
 */
let openSessions = 0;

export function markNativePlaidLinkOpened(): () => void {
  openSessions += 1;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    openSessions = Math.max(0, openSessions - 1);
  };
}

export function isNativePlaidLinkOpen(): boolean {
  return openSessions > 0;
}
