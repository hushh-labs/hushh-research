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
 * This hook restores the crossfade envelope by intercepting same-origin link
 * clicks, fading the current page OUT for a short beat, THEN pushing the route.
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
 * beat is played by the pathname effect once the new route resolves. Exported so
 * programmatic navigations share the exact same frame as link clicks.
 */
export function beginRouteTransition(
  targetHref: string,
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
  maxPendingTimer = window.setTimeout(
    () => setRouteState("idle"),
    MAX_PENDING_MS,
  );
  settleTimer = window.setTimeout(() => {
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (
      current === targetHref &&
      document.documentElement.dataset.routeTransition === "pending"
    ) {
      playEnter();
    }
  }, SETTLE_MS);

  window.setTimeout(navigate, EXIT_MS);
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

  if (
    url.pathname === window.location.pathname &&
    url.search === window.location.search
  ) {
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
    document.addEventListener("click", onClick, true);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      clearRouteTimers();
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("pageshow", onPageShow);
      delete document.documentElement.dataset.routeTransition;
      document.documentElement.removeAttribute("aria-busy");
    };
  }, [router]);

  // When the resolved pathname actually changes — which covers back/forward and
  // programmatic pushes that did not go through a click — play the enter beat so
  // every route switch shares the /one -> /one/* frame. (Query-only switches and
  // link/programmatic nav already get the full exit -> enter envelope via the
  // click interceptor and beginRouteTransition.)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (reducedMotion()) return;
    playEnter();
  }, [pathname]);
}
