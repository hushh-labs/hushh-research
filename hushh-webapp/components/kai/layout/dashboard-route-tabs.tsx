"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useKaiBottomChromeVisibility } from "@/lib/navigation/kai-bottom-chrome-visibility";
import {
  activeKaiRouteTabFromPath,
  KAI_ROUTE_TABS,
} from "@/lib/navigation/kai-route-tabs";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";
import { scrollAppToTop } from "@/lib/navigation/use-scroll-reset";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import {
  APP_SHELL_FRAME_CLASSNAME,
  APP_SHELL_FRAME_STYLE,
} from "@/components/app-ui/app-page-shell";

const SWIPE_AXIS_LOCK_THRESHOLD_PX = 6;
const SWIPE_VERTICAL_LIMIT_PX = 64;
const SWIPE_DIRECTION_RATIO = 1.12;
const SWIPE_COMMIT_DISTANCE_RATIO = 0.12;
const SWIPE_COMMIT_DISTANCE_MIN_PX = 36;
const SWIPE_COMMIT_DISTANCE_MAX_PX = 84;
const SWIPE_COMMIT_VELOCITY_PX_PER_MS = 0.5;
const SWIPE_MAX_DRAG_TABS = 1.15;

function hasHorizontalScrollParent(target: HTMLElement | null): boolean {
  if (!target || typeof window === "undefined") return false;
  let node: HTMLElement | null = target;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    const overflowX = style.overflowX;
    const canScroll =
      (overflowX === "auto" || overflowX === "scroll") &&
      node.scrollWidth > node.clientWidth + 4;
    if (canScroll) return true;
    node = node.parentElement;
  }
  return false;
}

function shouldIgnoreGlobalSwipeTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;

  if (element.closest('[data-tour-id="kai-route-tabs"]')) {
    return false;
  }

  if (
    element.closest(
      'input, textarea, select, [contenteditable="true"], [data-no-route-swipe], [data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="alert-dialog-content"], [data-slot="command"], [cmdk-root]'
    )
  ) {
    return true;
  }

  if (
    element.closest(
      '[data-slot="carousel"], [data-slot="carousel-content"], [data-slot="carousel-item"]'
    )
  ) {
    return true;
  }

  if (hasHorizontalScrollParent(element)) {
    return true;
  }

  return false;
}

interface DashboardRouteTabsProps {
  embedded?: boolean;
}

export function DashboardRouteTabs({ embedded = false }: DashboardRouteTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const hideTabsForPath =
    pathname.startsWith(ROUTES.KAI_ONBOARDING) || pathname.startsWith(ROUTES.KAI_IMPORT);
  const [mounted, setMounted] = useState(false);
  const tabsRootRef = useRef<HTMLDivElement | null>(null);
  const [dragOffsetTabs, setDragOffsetTabs] = useState(0);
  const [isDraggingIndicator, setIsDraggingIndicator] = useState(false);
  const { hidden: hideRouteTabs, progress: hideRouteTabsProgress } = useKaiBottomChromeVisibility(!hideTabsForPath);
  const busyOperations = useKaiSession((s) => s.busyOperations);

  const activeTab = useMemo(
    () => activeKaiRouteTabFromPath(pathname || ROUTES.KAI_HOME),
    [pathname]
  );

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const handleTabChange = useCallback(
    (nextTab: string) => {
      if (busyOperations["portfolio_save"]) {
        toast.info("Saving to vault. Please wait until encryption completes.");
        return;
      }
      const target = KAI_ROUTE_TABS.find((tab) => tab.id === nextTab);
      if (!target || target.id === activeTab) return;
      setDragOffsetTabs(0);
      setIsDraggingIndicator(false);
      scrollAppToTop("auto");
      router.push(target.href);
    },
    [activeTab, busyOperations, router]
  );

  useEffect(() => {
    if (!mounted || hideTabsForPath || typeof document === "undefined") {
      return;
    }

    const swipeSurface: Document | HTMLElement =
      document.querySelector<HTMLElement>("[data-app-scroll-root='true']") ?? document;

    let startX: number | null = null;
    let startY: number | null = null;
    let tracking = false;
    let gestureAxis: "undecided" | "horizontal" | "vertical" = "undecided";
    let ignoredTarget = false;
    let startTimestamp = 0;
    let activeTabIndexAtGestureStart = 0;
    let tabSlotWidthPx = 0;
    let indicatorDragging = false;
    let dragOffsetRef = 0;
    let rafHandle: number | null = null;

    const setDragOffsetRaf = (nextOffset: number) => {
      dragOffsetRef = nextOffset;
      if (rafHandle !== null) return;
      rafHandle = window.requestAnimationFrame(() => {
        rafHandle = null;
        setDragOffsetTabs(dragOffsetRef);
      });
    };

    const stopIndicatorDrag = () => {
      if (indicatorDragging) {
        indicatorDragging = false;
        setIsDraggingIndicator(false);
      }
      setDragOffsetRaf(0);
    };

    const resetGesture = () => {
      startX = null;
      startY = null;
      tracking = false;
      gestureAxis = "undecided";
      ignoredTarget = false;
      startTimestamp = 0;
      activeTabIndexAtGestureStart = 0;
      tabSlotWidthPx = 0;
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        stopIndicatorDrag();
        resetGesture();
        return;
      }

      ignoredTarget = shouldIgnoreGlobalSwipeTarget(event.target);
      if (ignoredTarget) {
        stopIndicatorDrag();
        resetGesture();
        return;
      }

      const touch = event.touches[0];
      if (!touch) {
        stopIndicatorDrag();
        resetGesture();
        return;
      }

      const tabsWidth =
        tabsRootRef.current?.getBoundingClientRect().width ??
        (typeof window !== "undefined" ? window.innerWidth : 0);
      tabSlotWidthPx = Math.max(1, tabsWidth / KAI_ROUTE_TABS.length);
      activeTabIndexAtGestureStart = Math.max(
        0,
        KAI_ROUTE_TABS.findIndex((tab) => tab.id === activeTab)
      );
      startTimestamp = event.timeStamp || performance.now();
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
      gestureAxis = "undecided";
      stopIndicatorDrag();
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking || ignoredTarget || event.touches.length === 0) {
        return;
      }

      const touch = event.touches[0];
      if (!touch || startX === null || startY === null) {
        return;
      }

      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (gestureAxis === "undecided") {
        if (absX < SWIPE_AXIS_LOCK_THRESHOLD_PX && absY < SWIPE_AXIS_LOCK_THRESHOLD_PX) {
          return;
        }

        if (absY > absX * 1.1) {
          gestureAxis = "vertical";
          tracking = false;
          stopIndicatorDrag();
          return;
        }

        if (absX > absY * 1.1) {
          gestureAxis = "horizontal";
        } else {
          return;
        }
      }

      if (
        gestureAxis !== "horizontal" ||
        absY > Math.max(20, absX * SWIPE_DIRECTION_RATIO)
      ) {
        tracking = false;
        stopIndicatorDrag();
        return;
      }

      if (!indicatorDragging) {
        indicatorDragging = true;
        setIsDraggingIndicator(true);
      }
      const rawOffsetTabs = -deltaX / Math.max(1, tabSlotWidthPx);
      const boundedOffsetTabs = Math.max(
        -SWIPE_MAX_DRAG_TABS,
        Math.min(SWIPE_MAX_DRAG_TABS, rawOffsetTabs)
      );
      const maxOffsetRight = KAI_ROUTE_TABS.length - 1 - activeTabIndexAtGestureStart;
      const maxOffsetLeft = -activeTabIndexAtGestureStart;
      const constrainedOffsetTabs = Math.max(
        maxOffsetLeft,
        Math.min(maxOffsetRight, boundedOffsetTabs)
      );
      setDragOffsetRaf(constrainedOffsetTabs);
      event.preventDefault();
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking || ignoredTarget || event.changedTouches.length === 0) {
        stopIndicatorDrag();
        resetGesture();
        return;
      }

      const touch = event.changedTouches[0];
      if (!touch || startX === null || startY === null) {
        stopIndicatorDrag();
        resetGesture();
        return;
      }

      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      const finalAxis = gestureAxis;
      const durationMs = Math.max(1, (event.timeStamp || performance.now()) - startTimestamp);
      const swipeVelocity = absX / durationMs;
      const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 390;
      const commitDistancePx = Math.max(
        SWIPE_COMMIT_DISTANCE_MIN_PX,
        Math.min(SWIPE_COMMIT_DISTANCE_MAX_PX, viewportWidth * SWIPE_COMMIT_DISTANCE_RATIO)
      );
      stopIndicatorDrag();
      resetGesture();

      if (
        finalAxis !== "horizontal" ||
        absY > SWIPE_VERTICAL_LIMIT_PX ||
        absX < absY * SWIPE_DIRECTION_RATIO
      ) {
        return;
      }

      if (absX < commitDistancePx && swipeVelocity < SWIPE_COMMIT_VELOCITY_PX_PER_MS) {
        return;
      }

      const activeIndex = Math.max(
        0,
        KAI_ROUTE_TABS.findIndex((tab) => tab.id === activeTab)
      );
      const direction = deltaX < 0 ? 1 : -1;
      const target = KAI_ROUTE_TABS[activeIndex + direction];
      if (!target) return;
      if (busyOperations["portfolio_save"]) {
        toast.info("Saving to vault. Please wait until encryption completes.");
        return;
      }

      scrollAppToTop("auto");
      router.push(target.href);
    };

    const onTouchCancel = () => {
      stopIndicatorDrag();
      resetGesture();
    };

    const touchStartListener: EventListener = (event) => onTouchStart(event as TouchEvent);
    const touchMoveListener: EventListener = (event) => onTouchMove(event as TouchEvent);
    const touchEndListener: EventListener = (event) => onTouchEnd(event as TouchEvent);
    const touchCancelListener: EventListener = () => onTouchCancel();

    swipeSurface.addEventListener("touchstart", touchStartListener, { passive: true });
    swipeSurface.addEventListener("touchmove", touchMoveListener, { passive: false });
    swipeSurface.addEventListener("touchend", touchEndListener, { passive: true });
    swipeSurface.addEventListener("touchcancel", touchCancelListener, { passive: true });

    return () => {
      if (rafHandle !== null) {
        window.cancelAnimationFrame(rafHandle);
      }
      swipeSurface.removeEventListener("touchstart", touchStartListener);
      swipeSurface.removeEventListener("touchmove", touchMoveListener);
      swipeSurface.removeEventListener("touchend", touchEndListener);
      swipeSurface.removeEventListener("touchcancel", touchCancelListener);
    };
  }, [mounted, hideTabsForPath, activeTab, busyOperations, router]);

  if (!mounted || hideTabsForPath) {
    return null;
  }

  const activeTabIndex = Math.max(
    0,
    KAI_ROUTE_TABS.findIndex((tab) => tab.id === activeTab)
  );
  const maxTabIndex = KAI_ROUTE_TABS.length - 1;
  const indicatorIndex = Math.max(
    0,
    Math.min(maxTabIndex, activeTabIndex + dragOffsetTabs)
  );

  const tabsBody = (
    <>
      <div className="relative grid grid-cols-3 items-center border-b border-border/70 px-1">
        {KAI_ROUTE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => handleTabChange(tab.id)}
            className={cn(
              "relative z-[1] h-8 text-sm font-semibold transition-colors duration-200",
              tab.id === activeTab
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
            aria-current={tab.id === activeTab ? "page" : undefined}
          >
            {tab.label}
          </button>
        ))}
        <span
          data-testid="kai-route-tabs-indicator"
          aria-hidden
          className={cn(
            "pointer-events-none absolute bottom-0 left-0 h-[3px] rounded-full bg-linear-to-r from-sky-500 via-primary to-sky-400 shadow-[0_0_0_1px_rgba(56,189,248,0.35),0_0_22px_rgba(56,189,248,0.62)]",
            isDraggingIndicator ? "transition-none" : "transition-transform duration-250 ease-out"
          )}
          style={{
            width: `calc(100% / ${KAI_ROUTE_TABS.length})`,
            transform: `translate3d(${indicatorIndex * 100}%, 0, 0)`,
          }}
        />
      </div>
    </>
  );

  if (embedded) {
    return (
      <div
        className={cn(
          "relative flex w-full justify-center transform-gpu will-change-transform",
          hideRouteTabs ? "pointer-events-none opacity-0" : "pointer-events-auto opacity-100"
        )}
        style={{
          transform: `translate3d(0, calc(${-100 * hideRouteTabsProgress}% - ${6 * hideRouteTabsProgress}px), 0)`,
          opacity: Math.max(0, 1 - hideRouteTabsProgress),
        }}
      >
        <div
          ref={tabsRootRef}
          data-tour-id="kai-route-tabs"
          className="pointer-events-auto w-full max-w-[460px] overflow-hidden"
        >
          {tabsBody}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        APP_SHELL_FRAME_CLASSNAME,
        "relative flex w-full justify-center transform-gpu will-change-transform",
        hideRouteTabs ? "pointer-events-none opacity-0" : "pointer-events-auto opacity-100"
      )}
      style={{
        ...APP_SHELL_FRAME_STYLE,
        transform: `translate3d(0, calc(${-100 * hideRouteTabsProgress}% - ${6 * hideRouteTabsProgress}px), 0)`,
        opacity: Math.max(0, 1 - hideRouteTabsProgress),
      }}
    >
      <div
        ref={tabsRootRef}
        data-tour-id="kai-route-tabs"
        className="pointer-events-auto w-full max-w-[460px] overflow-hidden"
      >
        {tabsBody}
      </div>
    </div>
  );
}
