"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";

import type { TopShellTabSet } from "@/lib/navigation/top-shell-tabs";
import { scrollAppToTop } from "@/lib/navigation/use-scroll-reset";
import { beginRouteTransition } from "@/lib/morphy-ux/hooks/use-route-transition";

const AXIS_LOCK_THRESHOLD_PX = 6;
const DIRECTION_RATIO = 1.12;
const VERTICAL_LIMIT_PX = 64;
const COMMIT_DISTANCE_RATIO = 0.12;
const COMMIT_DISTANCE_MIN_PX = 44;
const COMMIT_DISTANCE_MAX_PX = 90;
const COMMIT_VELOCITY_PX_PER_MS = 0.5;

function hasHorizontalScrollParent(target: HTMLElement | null): boolean {
  if (!target || typeof window === "undefined") return false;
  let node: HTMLElement | null = target;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    if (
      (style.overflowX === "auto" || style.overflowX === "scroll") &&
      node.scrollWidth > node.clientWidth + 4
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

function shouldIgnoreSwipeTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  if (
    element.closest(
      'input, textarea, select, [contenteditable="true"], [data-no-route-swipe], [data-swipe-views-horizontal-scroll], [data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="alert-dialog-content"], [data-slot="command"], [cmdk-root], [data-slot="carousel"], [data-slot="carousel-content"], [data-slot="carousel-item"]',
    )
  ) {
    return true;
  }
  return hasHorizontalScrollParent(element);
}

/**
 * Route-hop gestures for finite, route-backed shell tabs. Consent is the one
 * query-backed exception: its tab registry produces complete canonical URLs
 * and clears transient list/detail state before navigation. Other query-backed
 * workspaces retain their controlled pager.
 */
export function TopShellRouteSwipe({
  children,
  tabSet,
}: {
  children: ReactNode;
  tabSet: TopShellTabSet | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const enabled = Boolean(
    tabSet &&
    (tabSet.queryParam === null || tabSet.id === "consent") &&
    tabSet.tabs.length > 1,
  );

  useEffect(() => {
    if (!enabled || !tabSet || typeof document === "undefined") return;
    const swipeSurface =
      document.querySelector<HTMLElement>("[data-app-scroll-root='true']") ??
      document;
    const activeIndex = Math.max(
      0,
      tabSet.tabs.findIndex((tab) => tab.value === tabSet.activeValue),
    );
    let startX: number | null = null;
    let startY: number | null = null;
    let startTimestamp = 0;
    let tracking = false;
    let ignored = false;
    let axis: "undecided" | "horizontal" | "vertical" = "undecided";

    const beginTracking = (
      target: EventTarget | null,
      clientX: number,
      clientY: number,
      timestamp: number,
    ) => {
      if (shouldIgnoreSwipeTarget(target)) return reset();
      startX = clientX;
      startY = clientY;
      startTimestamp = timestamp || performance.now();
      tracking = true;
    };

    const reset = () => {
      startX = null;
      startY = null;
      startTimestamp = 0;
      tracking = false;
      ignored = false;
      axis = "undecided";
    };

    const updateTracking = (clientX: number, clientY: number) => {
      if (
        !tracking ||
        ignored ||
        startX === null ||
        startY === null
      )
        return;
      const horizontal = Math.abs(clientX - startX);
      const vertical = Math.abs(clientY - startY);
      if (
        axis !== "undecided" ||
        (horizontal < AXIS_LOCK_THRESHOLD_PX &&
          vertical < AXIS_LOCK_THRESHOLD_PX)
      )
        return;
      axis =
        horizontal > vertical * DIRECTION_RATIO ? "horizontal" : "vertical";
      if (axis === "vertical") tracking = false;
    };

    const finishTracking = (
      clientX: number,
      clientY: number,
      timestamp: number,
    ) => {
      if (
        !tracking ||
        ignored ||
        startX === null ||
        startY === null
      )
        return reset();
      const deltaX = clientX - startX;
      const deltaY = clientY - startY;
      const horizontal = Math.abs(deltaX);
      const vertical = Math.abs(deltaY);
      const durationMs = Math.max(
        1,
        (timestamp || performance.now()) - startTimestamp,
      );
      const velocity = horizontal / durationMs;
      const finalAxis = axis;
      reset();

      if (
        finalAxis !== "horizontal" ||
        vertical > VERTICAL_LIMIT_PX ||
        horizontal < vertical * DIRECTION_RATIO
      )
        return;
      const threshold = Math.max(
        COMMIT_DISTANCE_MIN_PX,
        Math.min(
          COMMIT_DISTANCE_MAX_PX,
          window.innerWidth * COMMIT_DISTANCE_RATIO,
        ),
      );
      if (horizontal < threshold && velocity < COMMIT_VELOCITY_PX_PER_MS)
        return;
      const destination = tabSet.tabs[activeIndex + (deltaX < 0 ? 1 : -1)];
      if (!destination || destination.href === pathname) return;
      scrollAppToTop("auto");
      beginRouteTransition(
        destination.href,
        () => router.push(destination.href, { scroll: false }),
        "tap",
        tabSet.queryParam ? "contextual" : "full",
      );
    };

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return reset();
      const touch = event.touches[0];
      if (!touch) return reset();
      beginTracking(event.target, touch.clientX, touch.clientY, event.timeStamp);
    };

    const onMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (touch) updateTracking(touch.clientX, touch.clientY);
    };

    const onEnd = (event: TouchEvent) => {
      if (event.changedTouches.length !== 1) return reset();
      const touch = event.changedTouches[0];
      if (!touch) return reset();
      finishTracking(touch.clientX, touch.clientY, event.timeStamp);
    };

    const startListener: EventListener = (event) =>
      onStart(event as TouchEvent);
    const moveListener: EventListener = (event) => onMove(event as TouchEvent);
    const endListener: EventListener = (event) => onEnd(event as TouchEvent);
    const cancelListener: EventListener = () => reset();
    // Embla-powered workspaces already receive Pointer Events. Consent uses
    // route-backed tabs so it previously listened only for Touch Events,
    // leaving desktop trackpads and pointer-capable WebViews with no gesture
    // path at all. Touch continues through the native path below to avoid a
    // duplicated navigation on browsers that emit both event families.
    const pointerStartListener: EventListener = (event) => {
      const pointer = event as PointerEvent;
      if (!pointer.isPrimary || pointer.pointerType === "touch") return;
      beginTracking(
        pointer.target,
        pointer.clientX,
        pointer.clientY,
        pointer.timeStamp,
      );
    };
    const pointerMoveListener: EventListener = (event) => {
      const pointer = event as PointerEvent;
      if (!pointer.isPrimary || pointer.pointerType === "touch") return;
      updateTracking(pointer.clientX, pointer.clientY);
    };
    const pointerEndListener: EventListener = (event) => {
      const pointer = event as PointerEvent;
      if (!pointer.isPrimary || pointer.pointerType === "touch") return;
      finishTracking(pointer.clientX, pointer.clientY, pointer.timeStamp);
    };
    swipeSurface.addEventListener("touchstart", startListener, {
      passive: true,
    });
    swipeSurface.addEventListener("touchmove", moveListener, { passive: true });
    swipeSurface.addEventListener("touchend", endListener, { passive: true });
    swipeSurface.addEventListener("touchcancel", cancelListener, {
      passive: true,
    });
    swipeSurface.addEventListener("pointerdown", pointerStartListener, {
      passive: true,
    });
    swipeSurface.addEventListener("pointermove", pointerMoveListener, {
      passive: true,
    });
    swipeSurface.addEventListener("pointerup", pointerEndListener, {
      passive: true,
    });
    swipeSurface.addEventListener("pointercancel", cancelListener, {
      passive: true,
    });
    return () => {
      swipeSurface.removeEventListener("touchstart", startListener);
      swipeSurface.removeEventListener("touchmove", moveListener);
      swipeSurface.removeEventListener("touchend", endListener);
      swipeSurface.removeEventListener("touchcancel", cancelListener);
      swipeSurface.removeEventListener("pointerdown", pointerStartListener);
      swipeSurface.removeEventListener("pointermove", pointerMoveListener);
      swipeSurface.removeEventListener("pointerup", pointerEndListener);
      swipeSurface.removeEventListener("pointercancel", cancelListener);
    };
  }, [enabled, pathname, router, tabSet]);

  return <>{children}</>;
}
