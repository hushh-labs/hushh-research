"use client";

import { ROUTES } from "@/lib/navigation/routes";

/**
 * Where a Mail connection that leaves the app for a full-page Google sign-in
 * comes back to. Mail and setup keep their own return (Mail, and the setup
 * correlation in `onboarding-connector-intent`); this exists only for the KYC
 * screen, which is not a Mail tab and would otherwise land on Mail.
 *
 * Only an opaque owner binding and one approved route are kept in browser
 * session storage: no OAuth code or state, no vault material, no mail. It is
 * owner-bound, expires, and names a route from a fixed list, never a path or
 * URL taken from the page address.
 */
const STORAGE_KEY = "hushh.gmail.connect_return.v1";
const MAX_AGE_MS = 15 * 60 * 1000;

export type GmailConnectReturnRoute = typeof ROUTES.ONE_KYC;
const APPROVED_RETURN_ROUTES: readonly string[] = [ROUTES.ONE_KYC];

type StoredReturn = {
  version: 1;
  ownerId: string;
  returnTo: GmailConnectReturnRoute;
  startedAt: number;
};

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Remember that this connection was started from the KYC screen. */
export function rememberGmailConnectReturn(
  ownerId: string,
  returnTo: GmailConnectReturnRoute,
): void {
  const store = storage();
  if (!store || !ownerId) return;
  const value: StoredReturn = { version: 1, ownerId, returnTo, startedAt: Date.now() };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Without it the return falls back to Mail, as it always did.
  }
}

/**
 * The approved route this owner's connection started from, or null for a
 * connection that started anywhere else. A marker for another owner, an expired
 * one, or one naming any other route is discarded.
 */
export function readGmailConnectReturn(
  ownerId: string | null | undefined,
): GmailConnectReturnRoute | null {
  const store = storage();
  const raw = store?.getItem(STORAGE_KEY);
  if (!store || !raw) return null;
  // Not signed in yet: the callback will sign in and come back, so keep it for then.
  if (!ownerId) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredReturn>;
    const valid =
      value.version === 1 &&
      value.ownerId === ownerId &&
      typeof value.returnTo === "string" &&
      APPROVED_RETURN_ROUTES.includes(value.returnTo) &&
      typeof value.startedAt === "number" &&
      Date.now() - value.startedAt <= MAX_AGE_MS;
    if (valid) return value.returnTo as GmailConnectReturnRoute;
  } catch {
    // Unreadable state is discarded below.
  }
  store.removeItem(STORAGE_KEY);
  return null;
}

export function clearGmailConnectReturn(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
