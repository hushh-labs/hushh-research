"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  appInteractionCoordinator,
  type InteractionIntentSource,
  type NavigationTransitionMode,
} from "@/lib/interaction/interaction-intent-coordinator";

/**
 * App-wide route transition driver.
 *
 * The app already plays a rich GSAP *enter* animation per route via
 * `usePageEnterAnimation`. What was missing — and what made navigation feel
 * like a hard cut compared to hussh-wiki / hushh-search-console — is the
 * *exit* half: the outgoing page used to vanish instantly the moment Next
 * swapped the route.
 *
 * This hook restores the crossfade envelope and makes it truly uniform across
 * EVERY navigation surface, not just `<a>` clicks. It does so at the layout
 * level via a single chokepoint:
 *
 *   1. Same-origin link clicks are intercepted directly (earliest possible
 *      exit start, before React re-renders).
 *   2. Programmatic navigation that has not yet migrated to the interaction
 *      coordinator is observed through the History API. Next.js requires its
 *      `pushState` / `replaceState` writes to complete synchronously, so this
 *      observer may start the visual envelope but MUST NOT defer, replay, or
 *      become the authority for the history mutation. Deferring those writes
 *      makes the App Router retry them and trips WebKit's 100-writes-per-10s
 *      safety limit during native authentication.
 *   3. Browser back/forward (`popstate`) plays the ENTER beat once the route
 *      resolves (the outgoing frame is already gone on a real history pop).
 *
 * It drives a single `data-route-transition` attribute on <html> with three
 * states that CSS keys off of (see globals.css → "UNIFORM ROUTE TRANSITION"):
 *
 *   idle      → no animation in flight
 *   pending   → outgoing page fades out (exit)
 *   entering  → incoming page fades in (enter)
 *
 * Timing/easing come from the shared motion tokens so the whole app shares one
 * frame. Reduced-motion users skip straight to navigation (CSS no-ops).
 */

// Kept in sync with the route-transition motion tokens in globals.css
// (--motion-route-exit-duration / --motion-route-enter-duration). Longer,
// gentler beats so navigation glides instead of feeling abrupt.
const EXIT_MS = 300;
const ENTER_MS = 360;
const MAX_PENDING_MS = 9_000;

type RouteTransitionState = "idle" | "pending" | "entering";

// Module-scoped timers so the exit/enter envelope is shared by BOTH the click
// interceptor and programmatic navigations (router.push from buttons, the
// bottom nav, internal-navigation events). This is what makes the /one ->
// /one/* crossfade play for *every* route/component switch, not just <a> clicks.
let clearTimer: number | null = null;
let maxPendingTimer: number | null = null;
let commitTimer: number | null = null;
let activeRouteIntentId: string | null = null;

// True while an explicitly coordinated navigation is committing. The History
// observer recognises the router's resulting write and passes it through
// without starting a second visual envelope.
let transitionInFlight = false;

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function clearRouteTimers() {
  if (clearTimer) window.clearTimeout(clearTimer);
  if (maxPendingTimer) window.clearTimeout(maxPendingTimer);
  if (commitTimer) window.clearTimeout(commitTimer);
  clearTimer = null;
  maxPendingTimer = null;
  commitTimer = null;
}

function playEnter() {
  if (maxPendingTimer) window.clearTimeout(maxPendingTimer);
  if (clearTimer) window.clearTimeout(clearTimer);
  maxPendingTimer = null;
  setRouteState("entering");
  clearTimer = window.setTimeout(() => setRouteState("idle"), ENTER_MS);
}

/**
 * Run the EXIT half of the route-transition envelope, then hand control to the
 * supplied `navigate` callback (router.push/replace). The incoming page's ENTER
 * beat is owned by the pathname effect once the new route resolves. Exported so
 * programmatic navigations share the exact same frame as link clicks.
 *
 * `targetHref` is accepted for call-site clarity/back-compat; the enter timing
 * is now driven by the resolved pathname, not this value.
 */
export function beginRouteTransition(
  targetHref: string,
  navigate: () => void,
  source: InteractionIntentSource = "programmatic",
  transitionMode: NavigationTransitionMode = "full",
): void {
  if (typeof window === "undefined") {
    navigate();
    return;
  }
  appInteractionCoordinator.requestNavigation({
    target: targetHref,
    source,
    transitionMode,
    start: (intent) => {
      activeRouteIntentId = intent.id;
      clearRouteTimers();
      if (transitionMode === "contextual" || reducedMotion()) {
        appInteractionCoordinator.markNavigationCommitting(intent.id);
        transitionInFlight = true;
        try {
          navigate();
        } finally {
          Promise.resolve().then(() => {
            transitionInFlight = false;
          });
        }
        return () => undefined;
      }

      setRouteState("pending");
      // Safety net only: if the new route never resolves (the pathname effect
      // owns the enter beat), force the visual layer back to idle.
      maxPendingTimer = window.setTimeout(
        () => {
          if (appInteractionCoordinator.isCurrentNavigation(intent.id)) {
            setRouteState("idle");
            appInteractionCoordinator.cancelNavigation(intent.id, "route_settlement_timeout");
          }
        },
        MAX_PENDING_MS,
      );
      // This timer is intentionally owned by the navigation intent. A newer
      // destination clears it before it can mutate history; that is the native
      // rapid-tap invariant the former global timer did not provide.
      commitTimer = window.setTimeout(() => {
        if (!appInteractionCoordinator.isCurrentNavigation(intent.id)) return;
        appInteractionCoordinator.markNavigationCommitting(intent.id);
        transitionInFlight = true;
        try {
          navigate();
        } finally {
          Promise.resolve().then(() => {
            transitionInFlight = false;
          });
        }
      }, EXIT_MS);

      return (reason) => {
        if (activeRouteIntentId !== intent.id) return;
        clearRouteTimers();
        activeRouteIntentId = null;
        if (reason !== "superseded_by_newer_navigation") {
          setRouteState("idle");
        }
      };
    },
  });
}

// ---------------------------------------------------------------------------
// History API observer — a compatibility visual chokepoint for programmatic
// navigation that has not yet migrated to the coordinator. It must never delay
// or replay Next.js's synchronous history mutation.
// ---------------------------------------------------------------------------

type HistoryMethod = "pushState" | "replaceState";

let historyPatched = false;
let originalPushState: History["pushState"] | null = null;
let originalReplaceState: History["replaceState"] | null = null;

/**
 * Normalised same-origin href for a history url arg, or null to skip.
 *
 * The crossfade is reserved for REAL screen-to-screen switches — i.e. the
 * `pathname` actually changes. Same-pathname writes (shallow query-string state
 * like `?panel=`, `?focus=`, `?tab=`, consent-sheet open/close, scroll-position
 * sync, and Next.js' own internal `replaceState` housekeeping) must NOT fade;
 * they are in-place updates and animating them looks abnormal/janky. Those pass
 * straight through to the original history method.
 */
function transitionTargetForHistory(
  url: string | URL | null | undefined,
): string | null {
  if (typeof window === "undefined") return null;
  if (url === null || url === undefined) return null;

  let resolved: URL;
  try {
    resolved = new URL(String(url), window.location.href);
  } catch {
    return null;
  }
  if (resolved.origin !== window.location.origin) return null;

  // Only a pathname change is a route switch. Query-only / hash-only / no-op
  // writes stay shallow and instant.
  if (resolved.pathname === window.location.pathname) {
    return null;
  }

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function patchHistory(): () => void {
  if (typeof window === "undefined") return () => {};
  if (historyPatched) return () => {};

  historyPatched = true;
  originalPushState = window.history.pushState.bind(window.history);
  originalReplaceState = window.history.replaceState.bind(window.history);

  const wrap = (method: HistoryMethod, original: History[HistoryMethod]) => {
    return function patched(
      this: History,
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      // Already inside an explicitly coordinated navigation, motion is disabled,
      // or this is a same-page write — perform it immediately.
      const target = transitionInFlight
        ? null
        : reducedMotion()
          ? null
          : transitionTargetForHistory(url);

      if (!target) {
        return original(data, unused, url ?? "");
      }

      // Compatibility callers did not open a coordinator intent before Next
      // reached the History API. Start only the visual exit here and preserve
      // the native synchronous mutation contract. The route-key effect owns
      // the enter after Next has committed the new surface; replaying the
      // outgoing page from a timer flashes stale content on slow renders.
      clearRouteTimers();
      setRouteState("pending");
      maxPendingTimer = window.setTimeout(
        () => setRouteState("idle"),
        MAX_PENDING_MS,
      );
      return original(data, unused, url ?? "");
    } as History[HistoryMethod];
  };

  window.history.pushState = wrap("pushState", originalPushState);
  window.history.replaceState = wrap("replaceState", originalReplaceState);

  return () => {
    if (originalPushState) window.history.pushState = originalPushState;
    if (originalReplaceState) window.history.replaceState = originalReplaceState;
    historyPatched = false;
    originalPushState = null;
    originalReplaceState = null;
  };
}

function internalHref(anchor: HTMLAnchorElement): string | null {
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) return null;
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;
  if (anchor.dataset.noRouteTransition === "true") return null;

  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return null;

  const lastSegment = url.pathname.split("/").pop() ?? "";
  if (/\.[a-z0-9]+$/i.test(lastSegment)) return null;

  // Reserve the crossfade for real route switches (pathname changes). Links that
  // only flip the query string or hash stay shallow/instant — same select check
  // as the History patch, so every entry point behaves identically.
  if (url.pathname === window.location.pathname) {
    return null;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

function setRouteState(state: RouteTransitionState) {
  const root = document.documentElement;
  root.dataset.routeTransition = state;
  if (state === "pending") {
    root.setAttribute("aria-busy", "true");
  } else {
    root.removeAttribute("aria-busy");
  }
}

export function useRouteTransition() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const mounted = useRef(false);
  const routeKey = searchParams.size
    ? `${pathname}?${searchParams.toString()}`
    : pathname;

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;

      const href = internalHref(anchor);
      if (!href) return;

      event.preventDefault();
      beginRouteTransition(href, () => router.push(href), "tap");
    }

    function onPageShow() {
      setRouteState("idle");
    }

    setRouteState("idle");
    // Observe history ONCE so compatibility router.push/replace callers receive
    // the visual envelope without delaying or replaying Next.js's mutation.
    const restoreHistory = patchHistory();
    document.addEventListener("click", onClick, true);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      if (activeRouteIntentId) {
        appInteractionCoordinator.cancelNavigation(
          activeRouteIntentId,
          "route_transition_unmounted",
        );
        activeRouteIntentId = null;
      } else {
        clearRouteTimers();
      }
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("pageshow", onPageShow);
      restoreHistory();
      delete document.documentElement.dataset.routeTransition;
      document.documentElement.removeAttribute("aria-busy");
    };
  }, [router]);

  // The resolved route key is the single, authoritative signal that the
  // NEW route has mounted — so this effect OWNS the enter beat for every
  // navigation path:
  //   • full envelope (link/programmatic): exit set "pending"; we now flip it to
  //     "entering" exactly when the route is ready. A fixed enter fallback
  //     would replay stale outgoing content before a slow route has mounted.
  //   • browser back/forward + reduced-motion-skipped nav: state is "idle"; we
  //     still reveal the incoming frame.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const activeIntent = appInteractionCoordinator
      .getSnapshot()
      .find((intent) => intent.id === activeRouteIntentId);
    const activeTarget = activeIntent?.target
      ? new URL(activeIntent.target, window.location.origin)
      : null;
    const targetRouteKey = activeTarget
      ? `${activeTarget.pathname}${activeTarget.search}`
      : null;
    const isContextualIntent = activeIntent?.transitionMode === "contextual";

    if (isContextualIntent) {
      if (targetRouteKey === routeKey && activeRouteIntentId) {
        appInteractionCoordinator.settleNavigation(
          activeRouteIntentId,
          "contextual_route_key_settled",
        );
        activeRouteIntentId = null;
      }
      return;
    }

    if (reducedMotion()) {
      if (activeRouteIntentId && targetRouteKey === routeKey) {
        appInteractionCoordinator.settleNavigation(
          activeRouteIntentId,
          "route_key_settled",
        );
        activeRouteIntentId = null;
      }
      return;
    }
    playEnter();
    if (activeRouteIntentId && targetRouteKey === routeKey) {
      appInteractionCoordinator.settleNavigation(activeRouteIntentId, "route_key_settled");
      activeRouteIntentId = null;
    }
  }, [pathname, routeKey]);
}
