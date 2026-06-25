"use client";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

export const INTERNAL_APP_NAVIGATION_REQUEST_EVENT = "app-internal-navigation-requested";

export type InternalAppNavigationRequest = {
  href: string;
  replace?: boolean;
  scroll?: boolean;
};

function canUseWindow(): boolean {
  return typeof window !== "undefined";
}

function isClientRoutableAppHref(href: string): boolean {
  return !(
    href === "/api" ||
    href.startsWith("/api/") ||
    href === "/_next" ||
    href.startsWith("/_next/") ||
    href === "/templates" ||
    href.startsWith("/templates/")
  );
}

export function normalizeInternalAppNavigationHref(
  value: string | null | undefined
): string | null {
  const href = String(value ?? "").trim();
  if (!href) return null;

  const directInternalHref = normalizeInternalRouteHref(href);
  if (directInternalHref) {
    return isClientRoutableAppHref(directInternalHref) ? directInternalHref : null;
  }

  if (!canUseWindow()) return null;

  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    const internalHref = normalizeInternalRouteHref(
      `${url.pathname}${url.search}${url.hash}`,
    );
    if (!internalHref) return null;
    return isClientRoutableAppHref(internalHref) ? internalHref : null;
  } catch {
    return null;
  }
}

export function assignWindowLocation(nextUrl: string): void {
  if (!canUseWindow()) return;
  const internalHref = normalizeInternalAppNavigationHref(nextUrl);
  if (internalHref) {
    requestInternalAppNavigation({ href: internalHref, scroll: false });
    return;
  }
  window.location.assign(nextUrl);
}

export function replaceWindowLocation(nextUrl: string): void {
  if (!canUseWindow()) return;
  const internalHref = normalizeInternalAppNavigationHref(nextUrl);
  if (internalHref) {
    requestInternalAppNavigation({
      href: internalHref,
      replace: true,
      scroll: false,
    });
    return;
  }
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
  const href = normalizeInternalAppNavigationHref(detail.href);
  if (!href) return false;
  window.dispatchEvent(
    new CustomEvent<InternalAppNavigationRequest>(
      INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
      {
        detail: {
          ...detail,
          href,
        },
      }
    )
  );
  return true;
}
