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
  const clearTimer = useRef<number | null>(null);
  const maxPendingTimer = useRef<number | null>(null);
  const settleTimer = useRef<number | null>(null);

  useEffect(() => {
    function clearTimers() {
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
      if (maxPendingTimer.current) window.clearTimeout(maxPendingTimer.current);
      if (settleTimer.current) window.clearTimeout(settleTimer.current);
      clearTimer.current = null;
      maxPendingTimer.current = null;
      settleTimer.current = null;
    }

    function enter() {
      if (maxPendingTimer.current) window.clearTimeout(maxPendingTimer.current);
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
      maxPendingTimer.current = null;
      setRouteState("entering");
      clearTimer.current = window.setTimeout(
        () => setRouteState("idle"),
        ENTER_MS,
      );
    }

    function begin(targetHref: string) {
      clearTimers();
      setRouteState("pending");
      maxPendingTimer.current = window.setTimeout(
        () => setRouteState("idle"),
        MAX_PENDING_MS,
      );
      settleTimer.current = window.setTimeout(() => {
        const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        if (
          current === targetHref &&
          document.documentElement.dataset.routeTransition === "pending"
        ) {
          enter();
        }
      }, SETTLE_MS);
    }

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
      begin(href);
      window.setTimeout(() => router.push(href), EXIT_MS);
    }

    function onPageShow() {
      setRouteState("idle");
    }

    setRouteState("idle");
    document.addEventListener("click", onClick, true);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      clearTimers();
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("pageshow", onPageShow);
      delete document.documentElement.dataset.routeTransition;
      document.documentElement.removeAttribute("aria-busy");
    };
  }, [router]);

  // When the resolved pathname actually changes (covers back/forward and
  // programmatic pushes that didn't go through a click), play the enter beat.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (clearTimer.current) window.clearTimeout(clearTimer.current);
    setRouteState("entering");
    clearTimer.current = window.setTimeout(
      () => setRouteState("idle"),
      ENTER_MS,
    );
  }, [pathname]);
}
