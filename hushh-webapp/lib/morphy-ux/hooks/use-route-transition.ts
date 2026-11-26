"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { prefetchInternalRoute } from "@/lib/utils/browser-navigation";
import { appHaptic } from "@/lib/capacitor/app-haptics";
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

// Kept in sync with the route-transition motion tokens in globals.css.
// On browsers supporting document.startViewTransition, navigation runs a
// simultaneous GPU-composited directional transition (150-170ms, crisp ease-out)
// with Top App Bar and Bottom Shell pinned rock-steady and zero blank-canvas
// blink. On fallback browsers, the CSS directional envelope uses EXIT_MS + ENTER_MS.
const EXIT_MS = 60;
const ENTER_MS = 160;
const MAX_PENDING_MS = 9_000;
const VIEW_TRANSITION_SETTLE_TIMEOUT_MS = 120;
const prefetchedInternalHrefs = new Set<string>();

type RouteTransitionState = "idle" | "pending" | "entering";
export type RouteTransitionDirection =
  | "tab-forward"
  | "tab-back"
  | "push"
  | "pop"
  | "crossfade";

type ViewTransitionHandle = {
  finished: Promise<void>;
  ready: Promise<void>;
  skipTransition: () => void;
};

type DocumentWithViewTransition = Document & {
  startViewTransition?: (
    update: () => void | Promise<void>,
  ) => ViewTransitionHandle;
};

const PEER_TAB_ORDER = ["/", "/one", "/one/connect", "/one/feed"] as const;

// Module-scoped timers so the transition envelope is shared by BOTH the click
// interceptor and programmatic navigations (router.push from buttons, the
// bottom nav, internal-navigation events).
let clearTimer: number | null = null;
let maxPendingTimer: number | null = null;
let commitTimer: number | null = null;
let enterFrame: number | null = null;
let activeRouteIntentId: string | null = null;
let activeViewTransition: ViewTransitionHandle | null = null;
let pendingViewTransitionResolve: (() => void) | null = null;
let viewTransitionTimeout: number | null = null;

// True while an explicitly coordinated navigation is committing. The History
// observer recognises the router's resulting write and passes it through
// without starting a second visual envelope.
let transitionInFlight = false;

function peerTabIndex(pathname: string): number {
  const clean = routePathname(pathname);
  return PEER_TAB_ORDER.indexOf(clean as (typeof PEER_TAB_ORDER)[number]);
}

function pathDepth(pathname: string): number {
  const clean = routePathname(pathname);
  if (clean === "/") return 0;
  return clean.split("/").filter(Boolean).length;
}

/**
 * Resolve the spatial transition grammar between two app pathnames:
 * - Peer bottom tabs (`Chat` <-> `One` <-> `Connect` <-> `Feed`) glide laterally
 *   following tab order (`tab-forward` / `tab-back`).
 * - Back navigation (`native_back` / `popstate`) or returning to a shallower
 *   screen plays the exact inverse `pop` glide.
 * - Deeper drill-downs from a tab or parent screen play `push`.
 * - Same-depth sibling switches default to a smooth simultaneous `crossfade`.
 */
export function resolveRouteTransitionDirection(
  fromPathname: string,
  toPathname: string,
  source: InteractionIntentSource | "popstate" = "programmatic",
): RouteTransitionDirection {
  const from = routePathname(fromPathname);
  const to = routePathname(toPathname);
  if (from === to) return "crossfade";

  const fromTab = peerTabIndex(from);
  const toTab = peerTabIndex(to);
  if (fromTab !== -1 && toTab !== -1) {
    return toTab > fromTab ? "tab-forward" : "tab-back";
  }

  if (source === "native_back" || source === "popstate") {
    return "pop";
  }

  if (toTab !== -1 && fromTab === -1) {
    return "pop";
  }

  if (fromTab !== -1 && toTab === -1) {
    return "push";
  }

  const fromDepth = pathDepth(from);
  const toDepth = pathDepth(to);
  if (toDepth > fromDepth) return "push";
  if (toDepth < fromDepth) return "pop";
  return "crossfade";
}

function resolveTargetPathname(href: string): string {
  if (typeof window === "undefined") return routePathname(href);
  try {
    return routePathname(new URL(href, window.location.href).pathname);
  } catch {
    return routePathname(href);
  }
}

function setRouteDirection(direction: RouteTransitionDirection) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.routeDirection = direction;
}

function supportsNativeViewTransitions(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as DocumentWithViewTransition;
  return typeof doc.startViewTransition === "function";
}

function canPinShellChromeForViewTransition(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.querySelectorAll('[data-ui-role="top-navigation"]').length <= 1 &&
    document.querySelectorAll("[data-app-bottom-shell]").length <= 1
  );
}

function completePendingViewTransition() {
  if (viewTransitionTimeout) {
    window.clearTimeout(viewTransitionTimeout);
    viewTransitionTimeout = null;
  }
  const resolve = pendingViewTransitionResolve;
  pendingViewTransitionResolve = null;
  resolve?.();
}

function cancelActiveViewTransition() {
  completePendingViewTransition();
  const handle = activeViewTransition;
  activeViewTransition = null;
  if (handle) {
    try {
      handle.skipTransition();
    } catch {
      // Already settled or aborted by browser.
    }
  }
  if (typeof document !== "undefined") {
    delete document.documentElement.dataset.viewTransitionActive;
  }
}

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
  if (viewTransitionTimeout) window.clearTimeout(viewTransitionTimeout);
  if (enterFrame !== null) window.cancelAnimationFrame(enterFrame);
  clearTimer = null;
  maxPendingTimer = null;
  commitTimer = null;
  viewTransitionTimeout = null;
  enterFrame = null;
}

function playEnter() {
  if (maxPendingTimer) window.clearTimeout(maxPendingTimer);
  if (clearTimer) window.clearTimeout(clearTimer);
  if (enterFrame !== null) window.cancelAnimationFrame(enterFrame);
  enterFrame = null;
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
  feedback?: "selection" | "light",
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
      const commit = () => {
        if (feedback && (source === "tap" || source === "native_back" || source === "search") &&
            new URL(targetHref, window.location.href).href !== window.location.href) appHaptic(feedback, intent.id);
        navigate();
      };
      activeRouteIntentId = intent.id;
      clearRouteTimers();
      // A target on the current pathname (the active bottom-nav tab tapped
      // again, a query-only rewrite) is not a route switch: the pathname
      // effect that owns the enter beat never fires, so a `pending` exit
      // would hold the shell at opacity 0 until the 9s safety net. The
      // History-API path already treats same-pathname writes as shallow
      // (transitionTargetForHistory); this is the same rule for
      // programmatic navigation.
      if (
        transitionMode === "contextual" ||
        reducedMotion() ||
        isCurrentPathname(targetHref)
      ) {
        // clearRouteTimers() above has just removed whatever would have
        // restored a `pending` exit left latched by an interrupted full
        // navigation. A contextual commit is instantaneous, so nothing may
        // stay faded out — `pending` holds the entire app shell at opacity 0.
        cancelActiveViewTransition();
        setRouteState("idle");
        appInteractionCoordinator.markNavigationCommitting(intent.id);
        transitionInFlight = true;
        try {
          commit();
        } finally {
          Promise.resolve().then(() => {
            transitionInFlight = false;
          });
        }
        return () => undefined;
      }

      const direction = resolveRouteTransitionDirection(
        window.location.pathname,
        resolveTargetPathname(targetHref),
        source,
      );
      setRouteDirection(direction);

      // Native View Transitions API: captures an opaque GPU snapshot of the
      // outgoing route and cross-glides simultaneously against the incoming
      // route while pinning Top App Bar and Bottom Nav rock-steady.
      if (supportsNativeViewTransitions()) {
        cancelActiveViewTransition();
        const doc = document as DocumentWithViewTransition;
        const root = document.documentElement;
        if (canPinShellChromeForViewTransition()) {
          root.dataset.viewTransitionActive = "true";
        }
        try {
          const transition = doc.startViewTransition!(() => {
            return new Promise<void>((resolve) => {
              pendingViewTransitionResolve = resolve;
              viewTransitionTimeout = window.setTimeout(() => {
                completePendingViewTransition();
              }, VIEW_TRANSITION_SETTLE_TIMEOUT_MS);

              if (!appInteractionCoordinator.isCurrentNavigation(intent.id)) {
                completePendingViewTransition();
                return;
              }
              appInteractionCoordinator.markNavigationCommitting(intent.id);
              transitionInFlight = true;
              try {
                commit();
              } finally {
                Promise.resolve().then(() => {
                  transitionInFlight = false;
                });
              }
            });
          });
          activeViewTransition = transition;
          void transition.finished.catch(() => undefined).finally(() => {
            if (activeViewTransition === transition) {
              activeViewTransition = null;
              delete root.dataset.viewTransitionActive;
            }
          });
          return () => {
            if (activeRouteIntentId !== intent.id) return;
            clearRouteTimers();
            cancelActiveViewTransition();
            activeRouteIntentId = null;
            setRouteState("idle");
          };
        } catch {
          cancelActiveViewTransition();
        }
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
          commit();
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
/**
 * A route pathname with the trailing slash dropped. The native export is
 * built with `trailingSlash: true`, so on the phone the page's pathname is
 * `/one/connect/` while every href in the app is `/one/connect`; compared
 * byte for byte, the active tab tapped again read as a route switch, the
 * shell went to its exit state, the destination never changed, the enter
 * beat never fired, and the screen stayed blank until the 9 s safety net
 * (bug log B51, the white screen on re-tapping Connect).
 */
function routePathname(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

/** True when `href` resolves to the pathname already on screen. */
export function isCurrentPathname(href: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      routePathname(new URL(href, window.location.href).pathname) ===
      routePathname(window.location.pathname)
    );
  } catch {
    return false;
  }
}

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
  // writes stay shallow and instant (trailing slash ignored: the native
  // export carries one, the app's hrefs do not).
  if (routePathname(resolved.pathname) === routePathname(window.location.pathname)) {
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
      // Already inside an explicitly coordinated navigation (including an
      // in-flight native View Transition whose Next.js pushState arrives
      // asynchronously after router.push), motion is disabled, or this is a
      // same-page write — perform it immediately without blanking the shell.
      const target =
        transitionInFlight ||
        pendingViewTransitionResolve !== null ||
        activeViewTransition !== null
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
      setRouteDirection(
        resolveRouteTransitionDirection(
          window.location.pathname,
          resolveTargetPathname(target),
          "programmatic",
        ),
      );
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
  const previousPathname = useRef(pathname);
  const previousLayoutPathname = useRef(pathname);
  const routeKey = searchParams.size
    ? `${pathname}?${searchParams.toString()}`
    : pathname;

  useEffect(() => {
    function warmInternalAnchor(target: EventTarget | null) {
      if (!(target instanceof Element)) return;
      if (typeof router.prefetch !== "function") return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = internalHref(anchor);
      if (!href || prefetchedInternalHrefs.has(href)) return;
      prefetchedInternalHrefs.add(href);
      prefetchInternalRoute(router, href);
    }

    function onPointerIntent(event: Event) {
      warmInternalAnchor(event.target);
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
      beginRouteTransition(href, () => router.push(href), "tap");
    }

    function onPageShow() {
      cancelActiveViewTransition();
      setRouteState("idle");
    }

    function onPopState() {
      setRouteDirection("pop");
    }

    setRouteState("idle");
    // Observe history ONCE so compatibility router.push/replace callers receive
    // the visual envelope without delaying or replaying Next.js's mutation.
    const restoreHistory = patchHistory();
    document.addEventListener("pointerdown", onPointerIntent, {
      capture: true,
      passive: true,
    });
    document.addEventListener("pointerover", onPointerIntent, {
      passive: true,
    });
    document.addEventListener("click", onClick, true);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("popstate", onPopState);

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
      cancelActiveViewTransition();
      document.removeEventListener("pointerdown", onPointerIntent, true);
      document.removeEventListener("pointerover", onPointerIntent);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("popstate", onPopState);
      restoreHistory();
      delete document.documentElement.dataset.routeTransition;
      delete document.documentElement.dataset.routeDirection;
      delete document.documentElement.dataset.viewTransitionActive;
      document.documentElement.removeAttribute("aria-busy");
    };
  }, [router]);

  // Warm visible same-origin links on idle after each route settles so tapping
  // capabilities on /one (Memory, Files, Location, Finance, etc.) commits
  // synchronously from the client router cache without cold chunk waterfalls.
  useEffect(() => {
    if (typeof window === "undefined" || typeof router.prefetch !== "function") {
      return;
    }
    const warmVisibleLinks = () => {
      const anchors = document.querySelectorAll<HTMLAnchorElement>("a[href]");
      let warmed = 0;
      for (const anchor of anchors) {
        if (warmed >= 16) break;
        const href = internalHref(anchor);
        if (!href || prefetchedInternalHrefs.has(href)) continue;
        prefetchedInternalHrefs.add(href);
        prefetchInternalRoute(router, href);
        warmed += 1;
      }
    };
    const win = window as Window & {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof win.requestIdleCallback === "function") {
      const id = win.requestIdleCallback(warmVisibleLinks, { timeout: 500 });
      return () => win.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(warmVisibleLinks, 120);
    return () => window.clearTimeout(timer);
  }, [pathname, router]);

  // Release any active View Transition synchronously as soon as React mutates
  // the incoming route's DOM. NEVER schedule this inside requestAnimationFrame:
  // browsers suppress rendering (and pause rAF) until startViewTransition's
  // updateCallback promise resolves.
  useLayoutEffect(() => {
    const pathnameChanged = previousLayoutPathname.current !== pathname;
    previousLayoutPathname.current = pathname;
    if (!pathnameChanged || !pendingViewTransitionResolve) return;
    completePendingViewTransition();
    setRouteState("idle");
  }, [pathname]);

  // The resolved route key is the single, authoritative signal that the
  // NEW route has mounted — so this effect OWNS the enter beat for every
  // navigation path:
  //   • full envelope (link/programmatic): exit set "pending"; we now flip it to
  //     "entering" exactly when the route is ready. A fixed enter fallback
  //     would replay stale outgoing content before a slow route has mounted.
  //   • browser back/forward + reduced-motion-skipped nav: state is "idle"; we
  //     still reveal the incoming frame.
  useEffect(() => {
    const pathnameChanged = previousPathname.current !== pathname;
    previousPathname.current = pathname;
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const activeIntent = appInteractionCoordinator
      .getSnapshot()
      .find((intent) => intent.id === activeRouteIntentId);
    const isContextualIntent = activeIntent?.transitionMode === "contextual";

    /**
     * Settle the navigation that has already handed its href to the router.
     *
     * A resolved route key reaching this effect IS the app reporting that it
     * moved, and that is the only authority worth trusting. Settlement used to
     * require the route key to string-match the intent's target, which it
     * routinely does not: a target is hand-built ("/one/location?view=links")
     * while the key is re-serialised from Next's parsed params, and Location's
     * own effects rewrite the query as the hub mounts. Every mismatch left the
     * navigation active forever, and an active navigation swallows the next
     * tap to the same place.
     *
     * Only a committed navigation settles. One still waiting out its exit beat
     * has a commit timer pending that checks it is still current, so retiring
     * it here would drop the navigation entirely.
     */
    const settleCommittedIntent = (reason: string) => {
      if (!activeRouteIntentId) return;
      if (activeIntent?.status !== "committing") return;
      appInteractionCoordinator.settleNavigation(activeRouteIntentId, reason);
      activeRouteIntentId = null;
    };

    if (isContextualIntent) {
      settleCommittedIntent("contextual_route_key_settled");
      // A contextual commit plays no enter beat, but it must never inherit a
      // `pending` exit from an interrupted full navigation and leave the shell
      // invisible.
      if (document.documentElement.dataset.routeTransition === "pending") {
        clearRouteTimers();
        setRouteState("idle");
      }
      return;
    }

    if (reducedMotion()) {
      cancelActiveViewTransition();
      settleCommittedIntent("route_key_settled");
      setRouteState("idle");
      return;
    }
    if (pathnameChanged) {
      if (pendingViewTransitionResolve) {
        completePendingViewTransition();
        setRouteState("idle");
      } else if (activeViewTransition) {
        setRouteState("idle");
      } else if (document.documentElement.dataset.routeTransition === "pending") {
        // Fallback browsers without View Transitions: let the incoming page's
        // first layout/paint frame complete before starting the directional enter.
        if (enterFrame !== null) window.cancelAnimationFrame(enterFrame);
        enterFrame = window.requestAnimationFrame(() => {
          enterFrame = window.requestAnimationFrame(() => {
            enterFrame = null;
            playEnter();
          });
        });
      } else {
        playEnter();
      }
    }
    settleCommittedIntent("route_key_settled");
  }, [pathname, routeKey]);
}
