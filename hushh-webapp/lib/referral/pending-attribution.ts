/**
 * The opaque attribution id, held across sign-in.
 *
 * Only the id is stored -- never the slug, and never anything about the
 * referrer. It is a server-issued handle: losing it costs the person nothing
 * (they simply arrive unattributed), and stealing it buys nothing, because
 * binding still requires the thief's own authenticated session and the server
 * refuses a second referrer for anyone who already has one.
 */

const STORAGE_KEY = "hushh.one.pendingReferralAttribution";

export function rememberPendingAttribution(attributionId: string): boolean {
  const value = String(attributionId || "").trim();
  if (!value) return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
    return true;
  } catch {
    // Private mode, or a full quota. The person can still sign in and use the
    // app; they just arrive without an attribution.
    return false;
  }
}

export function readPendingAttribution(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function clearPendingAttribution(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A value we cannot remove is one we also cannot read.
  }
}
