"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

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
 *   2. ALL programmatic navigation — `router.push` / `router.replace` from
 *      buttons, the bottom nav, tab bars, the top app bar, onboarding handlers,
 *      voice/agent runtimes, guards, anything — is caught by patching the
 *      History API (`history.pushState` / `history.replaceState`) ONCE. Next.js
 *      App Router routes every programmatic navigation through those two
 *      methods, so wrapping them is the one place that covers all ~185 call
 *      sites without editing a single one. The patch fades the outgoing page
 *      OUT, then defers the real history mutation by one exit beat.
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
const EXIT_MS = 500;
const ENTER_MS = 600;
const MAX_PENDING_MS = 9_000;
const SETTLE_MS = 200;

type RouteTransitionState = "idle" | "pending" | "entering";

// Module-scoped timers so the exit/enter envelope is shared by BOTH the click
// interceptor and programmatic navigations (router.push from buttons, the
// bottom nav, internal-navigation events). This is what makes the /one ->
// /one/* crossfade play for *every* route/component switch, not just <a> clicks.
let clearTimer: number | null = null;
let maxPendingTimer: number | null = null;
let settleTimer: number | null = null;

// True while the exit beat is playing and we are about to perform the *real*
// history mutation. Lets the patched pushState/replaceState recognise the
// deferred call we issue from beginRouteTransition and pass it straight through
// to the original method instead of starting a second envelope.
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
  if (settleTimer) window.clearTimeout(settleTimer);
  clearTimer = null;
  maxPendingTimer = null;
  settleTimer = null;
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
  _targetHref: string,
  navigate: () => void,
): void {
  if (typeof window === "undefined") {
    navigate();
    return;
  }
  if (reducedMotion()) {
    navigate();
    return;
  }

  clearRouteTimers();
  setRouteState("pending");
  // Safety net only: if the new route never resolves (the pathname effect that
  // owns the enter beat never fires), force back to idle so the page is never
  // left stuck faded out.
  maxPendingTimer = window.setTimeout(
    () => setRouteState("idle"),
    MAX_PENDING_MS,
  );
  // Belt-and-suspenders: if for some reason the pathname effect does not run
  // (e.g. a replace to the same component tree), still reveal after a short
  // settle so we never sit on a faded-out frame.
  settleTimer = window.setTimeout(() => {
    if (document.documentElement.dataset.routeTransition === "pending") {
      playEnter();
    }
  }, EXIT_MS + SETTLE_MS);

  window.setTimeout(() => {
    // Flag the real navigation so the patched history methods let it through
    // instead of opening a second envelope. Cleared on a microtask so any
    // synchronous pushState/replaceState triggered by `navigate` is covered.
    transitionInFlight = true;
    try {
      navigate();
    } finally {
      Promise.resolve().then(() => {
        transitionInFlight = false;
      });
    }
  }, EXIT_MS);
}

// ---------------------------------------------------------------------------
// History API patch — the single layout-level chokepoint that gives EVERY
// programmatic navigation the same exit -> enter envelope as link clicks.
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
      // Already inside the deferred real navigation, or motion is disabled,
      // or this is a same-page write — perform it immediately.
      const target = transitionInFlight
        ? null
        : reducedMotion()
          ? null
          : transitionTargetForHistory(url);

      if (!target) {
        return original(data, unused, url ?? "");
      }

      // Run the exit beat, then perform the real history mutation. replaceState
      // keeps replace semantics; pushState keeps push semantics.
      beginRouteTransition(target, () => original(data, unused, url ?? ""));
      // Return synchronously; Next.js does not rely on the return value here.
      return undefined as unknown as void;
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
  const router = useRouter();
  const mounted = useRef(false);

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
      beginRouteTransition(href, () => router.push(href));
    }

    function onPageShow() {
      setRouteState("idle");
    }

    setRouteState("idle");
    // Patch history ONCE so every programmatic router.push/replace flows through
    // the same exit -> enter envelope (see patchHistory). This is the layout-
    // level chokepoint that makes the crossfade uniform without editing call
    // sites.
    const restoreHistory = patchHistory();
    document.addEventListener("click", onClick, true);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      clearRouteTimers();
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("pageshow", onPageShow);
      restoreHistory();
      delete document.documentElement.dataset.routeTransition;
      document.documentElement.removeAttribute("aria-busy");
    };
  }, [router]);

  // The resolved pathname change is the single, authoritative signal that the
  // NEW route has mounted — so this effect OWNS the enter beat for every
  // navigation path:
  //   • full envelope (link/programmatic): exit set "pending"; we now flip it to
  //     "entering" exactly when the route is ready (accurate, no fixed-delay
  //     guess and no double-fire — the settle timer is now only a fallback).
  //   • browser back/forward + reduced-motion-skipped nav: state is "idle"; we
  //     still reveal the incoming frame.
  // Reserving on pathname (not search) means shallow query/hash writes never
  // re-trigger the enter beat, which is what made other routes feel abnormal.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (reducedMotion()) return;
    playEnter();
  }, [pathname]);
}
