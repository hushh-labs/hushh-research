"use client";

/**
 * RIA sub-agent — Apple-style swipe pager (route-hop model).
 *
 * The pinned chrome (top bar + bottom nav + ask-bar) already survives
 * router.push (it's mounted once, globally). This wrapper adds the "content
 * swipes between tabs" half: a horizontal swipe on the RIA content region
 * navigates to the adjacent tab (router.push), so the screen changes while the
 * chrome stays put.
 *
 * Deliberately NOT a co-mounted embla pager: Connect (= /marketplace) is a
 * heavy shared route with its own card-deck swipe, so co-mounting would fire its
 * ~20 network calls everywhere and start a gesture war. Instead each tab stays a
 * real route; this only detects the gesture and hops.
 *
 * Order / adjacency / active index derive from the canonical RIA workspace
 * tabs, so the swipe order always matches the visible top tab bar. Mounted in
 * app/ria/layout.tsx, so it is RIA-scoped by construction and naturally absent
 * on /marketplace (Connect keeps its own swipe).
 */

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";

import {
  activeRiaRouteTabFromPath,
  RIA_ROUTE_TABS,
} from "@/lib/navigation/ria-route-tabs";
import { isRiaOnboardingRoute } from "@/lib/navigation/routes";
import { scrollAppToTop } from "@/lib/navigation/use-scroll-reset";

const AXIS_LOCK_THRESHOLD_PX = 6;
const VERTICAL_LIMIT_PX = 64;
const DIRECTION_RATIO = 1.12;
const COMMIT_DISTANCE_RATIO = 0.12;
const COMMIT_DISTANCE_MIN_PX = 44;
const COMMIT_DISTANCE_MAX_PX = 90;
const COMMIT_VELOCITY_PX_PER_MS = 0.5;

function hasHorizontalScrollParent(target: HTMLElement | null): boolean {
  if (!target || typeof window === "undefined") return false;
  let node: HTMLElement | null = target;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    const overflowX = style.overflowX;
    if (
      (overflowX === "auto" || overflowX === "scroll") &&
      node.scrollWidth > node.clientWidth + 4
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

/** Skip the gesture over inputs, dialogs, carousels, opt-outs, h-scrollers. */
function shouldIgnoreSwipeTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  if (
    element.closest(
      'input, textarea, select, [contenteditable="true"], [data-no-route-swipe], [data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="alert-dialog-content"], [data-slot="command"], [cmdk-root], [data-slot="carousel"], [data-slot="carousel-content"], [data-slot="carousel-item"]',
    )
  ) {
    return true;
  }
  return hasHorizontalScrollParent(element);
}

export function RiaSwipePager({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (typeof document === "undefined") return;
    // Onboarding is a 5-step wizard inside the pinned chrome. A horizontal swipe
    // must page the STEPS (not hop tabs, which would eject to /ria/clients). On
    // onboarding we emit a step-nav event the onboarding page listens for;
    // everywhere else the swipe hops to the adjacent tab.
    const onboarding = isRiaOnboardingRoute(pathname);

    const swipeSurface: Document | HTMLElement =
      document.querySelector<HTMLElement>("[data-app-scroll-root='true']") ??
      document;

    const activeTab = activeRiaRouteTabFromPath(pathname || "/ria");
    const activeIndex = Math.max(
      0,
      RIA_ROUTE_TABS.findIndex((tab) => tab.id === activeTab),
    );

    let startX: number | null = null;
    let startY: number | null = null;
    let tracking = false;
    let axis: "undecided" | "horizontal" | "vertical" = "undecided";
    let ignored = false;
    let startTs = 0;

    const reset = () => {
      startX = null;
      startY = null;
      tracking = false;
      axis = "undecided";
      ignored = false;
      startTs = 0;
    };

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return reset();
      ignored = shouldIgnoreSwipeTarget(event.target);
      if (ignored) return reset();
      const touch = event.touches[0];
      if (!touch) return reset();
      startX = touch.clientX;
      startY = touch.clientY;
      startTs = event.timeStamp || performance.now();
      tracking = true;
      axis = "undecided";
    };

    const onMove = (event: TouchEvent) => {
      if (!tracking || ignored || event.touches.length === 0) return;
      const touch = event.touches[0];
      if (!touch || startX === null || startY === null) return;
      const absX = Math.abs(touch.clientX - startX);
      const absY = Math.abs(touch.clientY - startY);
      if (axis === "undecided") {
        if (absX < AXIS_LOCK_THRESHOLD_PX && absY < AXIS_LOCK_THRESHOLD_PX) {
          return;
        }
        // Vertical-dominant → release to the scroll container.
        axis = absX > absY * 1.1 ? "horizontal" : "vertical";
        if (axis === "vertical") {
          tracking = false;
          return;
        }
      }
    };

    const onEnd = (event: TouchEvent) => {
      if (!tracking || ignored || event.changedTouches.length === 0) {
        return reset();
      }
      const touch = event.changedTouches[0];
      if (!touch || startX === null || startY === null) return reset();
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      const finalAxis = axis;
      const durationMs = Math.max(
        1,
        (event.timeStamp || performance.now()) - startTs,
      );
      const velocity = absX / durationMs;
      reset();

      if (
        finalAxis !== "horizontal" ||
        absY > VERTICAL_LIMIT_PX ||
        absX < absY * DIRECTION_RATIO
      ) {
        return;
      }
      const viewportWidth =
        typeof window !== "undefined" ? window.innerWidth : 390;
      const commitDistance = Math.max(
        COMMIT_DISTANCE_MIN_PX,
        Math.min(COMMIT_DISTANCE_MAX_PX, viewportWidth * COMMIT_DISTANCE_RATIO),
      );
      if (absX < commitDistance && velocity < COMMIT_VELOCITY_PX_PER_MS) {
        return;
      }

      const direction = deltaX < 0 ? 1 : -1;
      if (onboarding) {
        // Page the wizard steps; the onboarding page advances/goes back.
        window.dispatchEvent(
          new CustomEvent("ria-onboarding-swipe", { detail: { direction } }),
        );
        return;
      }
      const target = RIA_ROUTE_TABS[activeIndex + direction];
      if (!target) return;
      scrollAppToTop("auto");
      router.push(target.href);
    };

    const startListener: EventListener = (e) => onStart(e as TouchEvent);
    const moveListener: EventListener = (e) => onMove(e as TouchEvent);
    const endListener: EventListener = (e) => onEnd(e as TouchEvent);
    const cancelListener: EventListener = () => reset();

    swipeSurface.addEventListener("touchstart", startListener, {
      passive: true,
    });
    swipeSurface.addEventListener("touchmove", moveListener, { passive: true });
    swipeSurface.addEventListener("touchend", endListener, { passive: true });
    swipeSurface.addEventListener("touchcancel", cancelListener, {
      passive: true,
    });

    return () => {
      swipeSurface.removeEventListener("touchstart", startListener);
      swipeSurface.removeEventListener("touchmove", moveListener);
      swipeSurface.removeEventListener("touchend", endListener);
      swipeSurface.removeEventListener("touchcancel", cancelListener);
    };
  }, [pathname, router]);

  return <>{children}</>;
}
