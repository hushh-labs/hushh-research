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

import { useLayoutEffect } from "react";
import { Capacitor } from "@capacitor/core";
import {
  navigateTopShellBack,
  type TopShellBackAction,
} from "@/lib/navigation/top-shell-back";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { ROUTES } from "@/lib/navigation/routes";
import { resolveProfilePaneUrlState, profilePaneHistoryDepth, personPreviewHistoryEntry } from "@/lib/navigation/profile-pane";
import { dismissTopmostOverlay } from "@/lib/navigation/back-layers";
import { isPersonProfilePreviewOpen } from "@/lib/connections/person-profile-preview";

export type RouteLocation = { pathname: string; search: string };

export type WebHistoryBackCorrection = {
  href: string;
  transitionMode: "full" | "contextual";
};

type NavigateTopShellBack = typeof navigateTopShellBack;

// Optional browser API: older engines retain the popstate fallback below.
type BrowserNavigation = EventTarget & {
  currentEntry: { index: number } | null;
};
type BrowserNavigateEvent = Event & {
  navigationType: string;
  destination: { index: number; sameDocument: boolean };
};

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
 * for two independent reasons: (1) untrusted (synthetic) events below only
 * refresh the owner's snapshot and never navigate; (2) belt-and-suspenders,
 * skip explicitly whenever either side
 * of a transition is Profile-Pane-governed, independent of isTrusted fidelity.
 */
function isProfilePaneGoverned(location: RouteLocation): boolean {
  if (resolveProfilePaneUrlState(location.search).open) return true;
  if (location.pathname !== ROUTES.PROFILE) return false;
  const params = new URLSearchParams(location.search);
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
let lastSettledIndex: number | null = null;

/** Unknown direction must never turn Forward into a route-parent action. */
export function isBackwardHistoryTraversal(previous: number | null, revealed: number | null): boolean {
  return previous !== null && revealed !== null &&
    Number.isInteger(previous) && Number.isInteger(revealed) &&
    previous >= 0 && revealed >= 0 && revealed < previous;
}

function navigationEntryIndex(): number | null {
  const index = (window as Window & {
    navigation?: { currentEntry?: { index?: number } | null };
  }).navigation?.currentEntry?.index;
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : null;
}

let lastSettledHistoryState: unknown = null;

function isOverlayAbovePersonPreview(doc: Document): boolean {
  const overlays = doc.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
  return isPersonProfilePreviewOpen(doc) && !overlays[overlays.length - 1]?.hasAttribute("data-person-profile-preview");
}

function isTopmostConfirmationOpen(doc: Document): boolean {
  const overlays = doc.querySelectorAll<HTMLElement>(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
  );
  return overlays[overlays.length - 1]?.getAttribute("role") === "alertdialog" || isPersonProfilePreviewOpen(doc);
}

function recordCurrentBrowserHistory(): void {
  // A router can commit the popped parent before this shell's listener runs.
  // Keep the confirmation's underlying entry until Back consumes the overlay.
  if (lastSettled && isProfilePaneGoverned(lastSettled) && isTopmostConfirmationOpen(document)) return;
  lastSettled = { pathname: window.location.pathname, search: window.location.search };
  lastSettledIndex = navigationEntryIndex();
  lastSettledHistoryState = window.history.state;
}

/** A confirmation above Profile consumes Back before the pane stack does. */
export function dismissProfileConfirmationOnBack(params: {
  previous: RouteLocation | null;
  previousHistoryState: unknown;
  revealedHistoryState: unknown;
  doc?: Document;
  previousEntryIndex?: number | null;
  revealedEntryIndex?: number | null;
}): boolean {
  if (!params.previous || !isProfilePaneGoverned(params.previous)) return false;
  if (params.previousEntryIndex != null && params.revealedEntryIndex != null &&
      !isBackwardHistoryTraversal(params.previousEntryIndex, params.revealedEntryIndex)) return false;
  if (
    profilePaneHistoryDepth(params.previousHistoryState) <=
    profilePaneHistoryDepth(params.revealedHistoryState)
  ) return false;
  const doc = params.doc ?? document;
  // Profile is itself a dialog. Only a confirmation layered above it consumes
  // this entry; ordinary pane Back and Forward retain their authored history.
  if (!isTopmostConfirmationOpen(doc)) return false;
  return dismissTopmostOverlay(doc);
}

/**
 * Mounted once in AppShellFrame (app/providers.tsx), next to the existing
 * recordDestinationEntry effect it shares a pathname/search source with.
 * Mutually exclusive with the iOS edge gesture and Android hardware-back
 * handlers: gated to exactly the platforms those two don't cover.
 */
export function useWebHistoryBack(pathname: string, search: string): void {
  // Pair the browser URL with its history state before passive navigation
  // effects run. Profile can write its entry before Next's query render
  // settles, so delayed router props must not replace the owner's snapshot.
  useLayoutEffect(() => {
    recordCurrentBrowserHistory();
  }, [pathname, search]);

  // Register before this shell's passive subscriptions. Next may already
  // listen on Window, so pre-navigation cancellation prevents the parent flash.
  useLayoutEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    if (typeof window === "undefined") return;

    // WebKit cancellation skips the next parent in the traversal regression.
    // Keep its popstate restoration until that engine can preserve the cursor.
    const navigation = /(?:Chrome|Chromium)\//.test(navigator.userAgent)
      ? (window as Window & { navigation?: BrowserNavigation }).navigation
      : undefined;
    const onNavigate = (event: Event) => {
      const traversal = event as BrowserNavigateEvent;
      const currentIndex = navigation?.currentEntry?.index;
      if (
        !event.isTrusted || traversal.navigationType !== "traverse" ||
        !traversal.destination.sameDocument ||
        !event.cancelable || event.defaultPrevented ||
        currentIndex == null || currentIndex < 0 ||
        traversal.destination.index < 0 ||
        traversal.destination.index >= currentIndex ||
        (personPreviewHistoryEntry(window.history.state) !== null && !isOverlayAbovePersonPreview(document)) ||
        !(isPersonProfilePreviewOpen(document) ||
          (isProfilePaneGoverned({ pathname: window.location.pathname, search: window.location.search }) && isTopmostConfirmationOpen(document)))
      ) return;
      // Consume Back before the URL changes, so Next cannot animate the pane
      // underneath the confirmation. Escape keeps dismissal/refusal owned by it.
      event.preventDefault();
      dismissTopmostOverlay(document);
    };

    const onPopState = (event: PopStateEvent) => {
      // Profile writes its history synchronously, while Next's query render
      // can settle later. Keep the snapshot at the owner's actual entry so
      // the first browser Back sees Account even before that render commits.
      // Synthetic notifications refresh evidence only; they never navigate.
      if (!event.isTrusted) {
        recordCurrentBrowserHistory();
        return;
      }
      // A person preview owns a same-URL entry. Its pop reveals the still-mounted
      // source; generic route correction must not dismiss the source sheet.
      const previous = lastSettled;
      const previousIndex = lastSettledIndex;
      const previousHistoryState = lastSettledHistoryState;
      const revealed: RouteLocation = {
        pathname: window.location.pathname,
        search: window.location.search,
      };
      const revealedIndex = navigationEntryIndex();
      const restorePersonPreview = personPreviewHistoryEntry(previousHistoryState) !== null &&
        personPreviewHistoryEntry(event.state) === null && isOverlayAbovePersonPreview(document) &&
        (previousIndex == null || revealedIndex == null || isBackwardHistoryTraversal(previousIndex, revealedIndex));
      if (restorePersonPreview) dismissTopmostOverlay(document);
      if (restorePersonPreview || dismissProfileConfirmationOnBack({
        previous,
        previousHistoryState,
        revealedHistoryState: event.state,
        previousEntryIndex: previousIndex,
        revealedEntryIndex: revealedIndex,
      })) {
        // Run before Next observes the popped parent. Return to the original
        // entry so its pane metadata and any existing Forward history survive.
        // The returning pop has equal depth and follows normal pane handling.
        event.stopImmediatePropagation();
        window.history.go(
          restorePersonPreview ? 1 : profilePaneHistoryDepth(previousHistoryState) -
          profilePaneHistoryDepth(event.state),
        );
        return;
      }
      if (personPreviewHistoryEntry(previousHistoryState) !== null || personPreviewHistoryEntry(event.state) !== null) {
        lastSettled = { pathname: window.location.pathname, search: window.location.search };
        lastSettledIndex = navigationEntryIndex();
        lastSettledHistoryState = event.state;
        return;
      }
      lastSettled = revealed;
      lastSettledIndex = revealedIndex;
      lastSettledHistoryState = event.state;
      if (!isBackwardHistoryTraversal(previousIndex, revealedIndex)) return;
      const correction = decideWebHistoryBackCorrection(previous, revealed);
      // Permitted traversal (including Forward with a confirmation open)
      // establishes the next starting entry even while render snapshots freeze.
      lastSettled = revealed;
      lastSettledHistoryState = event.state;
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

    navigation?.addEventListener("navigate", onNavigate);
    window.addEventListener("popstate", onPopState, true);
    return () => {
      navigation?.removeEventListener("navigate", onNavigate);
      window.removeEventListener("popstate", onPopState, true);
    };
  }, []);
}
