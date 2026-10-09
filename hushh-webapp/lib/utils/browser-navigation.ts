"use client";

export const INTERNAL_APP_NAVIGATION_REQUEST_EVENT =
  "app-internal-navigation-requested";

export type InternalAppNavigationRequest = {
  href: string;
  replace?: boolean;
  scroll?: boolean;
  source?: "tap" | "voice" | "search" | "native_back" | "programmatic";
  transitionMode?: "full" | "contextual";
};

// Native notification actions can arrive before React mounts the shared router
// listener on a terminated-app launch. Keep only the latest intent in memory;
// it contains route metadata, never credentials or decrypted information.
let pendingInternalNavigation: InternalAppNavigationRequest | null = null;

function canUseWindow(): boolean {
  return typeof window !== "undefined";
}

export function assignWindowLocation(nextUrl: string): void {
  if (!canUseWindow()) return;
  window.location.assign(nextUrl);
}

export function replaceWindowLocation(nextUrl: string): void {
  if (!canUseWindow()) return;
  window.location.replace(nextUrl);
}

export function reloadWindow(): void {
  if (!canUseWindow()) return;
  window.location.reload();
}

export function openExternalUrl(url: string): void {
  if (!canUseWindow()) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Opens a link that is only known after an async lookup, from a click.
 *
 * A browser allows a new tab only straight from the click, so the tab is opened
 * first and pointed at the link once it resolves. If the lookup fails the tab is
 * closed again and the error is handed back; the link is never shown or kept.
 */
export async function openExternalUrlWhenResolved(
  resolveUrl: () => Promise<string>,
): Promise<void> {
  if (!canUseWindow()) return;
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  try {
    const url = await resolveUrl();
    if (tab && !tab.closed) {
      tab.location.replace(url);
    } else {
      openExternalUrl(url);
    }
  } catch (error) {
    if (tab && !tab.closed) tab.close();
    throw error;
  }
}

export function requestInternalAppNavigation(
  detail: InternalAppNavigationRequest,
): boolean {
  if (!canUseWindow()) return false;
  pendingInternalNavigation = detail;
  window.dispatchEvent(
    new CustomEvent<InternalAppNavigationRequest>(
      INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
      { detail },
    ),
  );
  return true;
}

export function consumePendingInternalAppNavigation(): InternalAppNavigationRequest | null {
  const pending = pendingInternalNavigation;
  pendingInternalNavigation = null;
  return pending;
}

export function acknowledgeInternalAppNavigation(
  detail: InternalAppNavigationRequest,
): void {
  if (pendingInternalNavigation === detail) {
    pendingInternalNavigation = null;
  }
}
