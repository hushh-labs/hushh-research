"use client";

export const INTERNAL_APP_NAVIGATION_REQUEST_EVENT = "app-internal-navigation-requested";

export type InternalAppNavigationRequest = {
  href: string;
  replace?: boolean;
  scroll?: boolean;
};

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

export function requestInternalAppNavigation(
  detail: InternalAppNavigationRequest
): boolean {
  if (!canUseWindow()) return false;
  window.dispatchEvent(
    new CustomEvent<InternalAppNavigationRequest>(
      INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
      { detail }
    )
  );
  return true;
}
