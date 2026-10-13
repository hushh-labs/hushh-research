"use client";

// lib/navigation/web-history-back.ts
//
// Closes the one back-triggering mechanism that doesn't yet consult the
// shared Back contract: a native browser `popstate` on web (back button,
// trackpad/mouse back gesture, mobile-browser edge-swipe, Alt+Left). The
// in-app top-bar arrow (top-app-bar.tsx), iOS's own edge gesture
// (app-edge-back-gesture.tsx), and Android's hardware back
// (android-back.ts) already resolve through navigateTopShellBack; this is
// the fourth and final mechanism, gated to exactly the platforms those three
// don't cover.
//
// Why this is needed: many in-app transitions (Location's `?action=` sheets,
// every top-shell-tabs.tsx sibling-tab switch, etc.) use router.replace so
// they don't pollute history (top-shell-back.ts's own doc comment: "query-only
// flows must close in place without becoming re-openable OS-back entries").
// That means the browser's real history stack often has only one entry for an
// entire multi-step flow, so a native pop jumps straight past it to whatever
// was there before -- typically the dashboard. This mechanism corrects that,
// and only that: it is a no-op everywhere the browser's real history already
// agrees with the contract.

import { useEffect, useLayoutEffect } from "react";
import { Capacitor } from "@capacitor/core";
import {
  navigateTopShellBack,
  type TopShellBackAction,
} from "@/lib/navigation/top-shell-back";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { ROUTES } from "@/lib/navigation/routes";
import { PROFILE_PANE_QUERY } from "@/lib/navigation/profile-pane";

export type RouteLocation = { pathname: string; search: string };

export type WebHistoryBackCorrection = {
  href: string;
  transitionMode: "full" | "contextual";
};

type NavigateTopShellBack = typeof navigateTopShellBack;

function pathnameOf(href: string): string {
  const path = href.split("#")[0]?.split("?")[0] ?? href;
  return path || href;
}

function searchOf(href: string): string {
  const query = href.split("#")[0]?.split("?")[1];
  return query ? `?${query}` : "";
}

/**
 * Profile Pane (lib/navigation/profile-pane.ts) already drives its own
 * drill-down over the current route with `?profile_pane=1`, real
 * history.pushState entries, and a synthetic `popstate` (emitHistoryUpdate)
 * to resync Next's router after each direct write. A real native pop while
 * the pane is open already reveals the authored parent -- this mechanism
 * must do nothing there,
 * for two independent reasons: (1) the primary guard below ignores untrusted
 * (synthetic) events entirely, since profile-pane.ts's own popstate is never
 * user-trusted; (2) belt-and-suspenders, skip explicitly whenever either side
 * of a transition is Profile-Pane-governed, independent of isTrusted fidelity.
 */
function isProfilePaneGoverned(location: RouteLocation): boolean {
  const params = new URLSearchParams(location.search);
  if (params.get(PROFILE_PANE_QUERY) === "1") return true;
  return location.pathname === ROUTES.PROFILE && Boolean(params.get("panel") || params.get("detail"));
}

/**
 * Decide whether a native back that already landed on `revealed` should be
 * corrected, and to where. Takes `navigateTopShellBack` as a parameter (not
 * imported and called directly) so it's testable with a mock, exactly like
 * android-back.ts's resolveAndroidBack is tested against a mocked resolver.
 *
 * `previous` is the location right before the browser's pop took effect --
 * popstate fires *after* window.location has already moved, so the caller
 * must capture this ahead of time (see useWebHistoryBack below).
 */
export function decideWebHistoryBackCorrection(
  previous: RouteLocation | null,
  revealed: RouteLocation,
  navigate: NavigateTopShellBack = navigateTopShellBack,
): WebHistoryBackCorrection | null {
  if (!previous) return null;
  if (isProfilePaneGoverned(previous) || isProfilePaneGoverned(revealed)) {
    return null;
  }

  let captured: TopShellBackAction | null = null;
  const handled = navigate({
    pathname: previous.pathname,
    searchParams: new URLSearchParams(previous.search),
    navigate: (action) => {
      captured = action;
    },
  });

  // No back action exists for `previous` (app root, or a hideBack route) --
  // trust the browser; this is the one case where its own pop is already
  // correct.
  if (!handled) return null;

  // navigateTopShellBack returned true (an overlay or back-layer consumed the
  // pop) but never named a navigation target: the correct action was "stay
  // here, just close the sheet," and the browser's pop has nothing to offer
  // back. Undo it by returning to `previous` itself.
  const targetHref = captured
    ? (captured as TopShellBackAction).href
    : `${previous.pathname}${previous.search}`;
  const targetPathname = pathnameOf(targetHref);
  const targetSearch = searchOf(targetHref);

  // Load-bearing safety property: everywhere the browser's real history
  // already agrees with the contract's answer, this is a no-op.
  if (targetPathname === revealed.pathname && targetSearch === revealed.search) {
    return null;
  }

  return {
    href: targetHref,
    // Recomputed against `revealed` (where the browser actually put us), not
    // `previous` (what the resolver's own action() helper compares against,
    // and which for this exact bug class -- a query-only replace flow --
    // always equals the target pathname, wrongly implying "contextual" for
    // what is visually a full screen swap).
    transitionMode: targetPathname === revealed.pathname ? "contextual" : "full",
  };
}

let lastSettled: RouteLocation | null = null;

/**
 * Mounted once in AppShellFrame (app/providers.tsx), next to the existing
 * recordDestinationEntry effect it shares a pathname/search source with.
 * Mutually exclusive with the iOS edge gesture and Android hardware-back
 * handlers: gated to exactly the platforms those two don't cover.
 */
export function useWebHistoryBack(pathname: string, search: string): void {
  // useLayoutEffect, not useEffect: the popstate listener below reads
  // `lastSettled` and must see the location current as of the last *render*,
  // before any later effect queues a navigation -- same reasoning as
  // back-layers.ts's useBackLayer keeping its callback ref current via
  // useLayoutEffect.
  useLayoutEffect(() => {
    // Normalize to window.location.search's own shape (a leading `?`, or
    // empty) regardless of what the caller passed -- AppShellFrame's own
    // `searchParams?.toString()` omits the leading `?`, but `revealed.search`
    // (read from window.location.search inside the popstate handler below)
    // always includes it, and the two are compared directly.
    const normalizedSearch = search ? (search.startsWith("?") ? search : `?${search}`) : "";
    lastSettled = { pathname, search: normalizedSearch };
  }, [pathname, search]);

  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    if (typeof window === "undefined") return;

    const onPopState = (event: PopStateEvent) => {
      // Ignore synthetic/programmatic popstate (profile-pane.ts's own
      // emitHistoryUpdate, or anything else dispatching one by hand) -- only
      // a real OS/browser back gesture is trusted.
      if (!event.isTrusted) return;
      const previous = lastSettled;
      const revealed: RouteLocation = {
        pathname: window.location.pathname,
        search: window.location.search,
      };
      const correction = decideWebHistoryBackCorrection(previous, revealed);
      if (!correction) return;
      // Always push, never replace: the browser already consumed a real
      // history entry to get here, so the correction must add a new one --
      // never destroy the entry the user just legitimately exposed. A
      // subsequent real back-press from the corrected screen gets its own
      // fresh popstate and is handled the same way.
      requestInternalAppNavigation({
        href: correction.href,
        replace: false,
        scroll: false,
        source: "native_back",
        transitionMode: correction.transitionMode,
      });
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
}
