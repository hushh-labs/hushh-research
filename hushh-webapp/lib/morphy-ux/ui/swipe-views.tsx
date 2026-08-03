"use client";

import React, { useCallback, useEffect, useMemo, useRef } from "react";
import type { EmblaCarouselType } from "embla-carousel";
import useEmblaCarousel from "embla-carousel-react";

import {
  setTopShellTabSwipeState,
  subscribeTopShellTabSelection,
} from "@/lib/navigation/top-shell-tab-swipe-progress";
import { cn } from "@/lib/utils";

/**
 * Marks an element whose horizontal drag must win over the workspace pager.
 *
 * A nested rail cannot rely on `touch-action` alone because Embla owns pointer
 * capture at the parent. The marker makes that arbitration explicit at the
 * shared pager boundary rather than requiring each route to work around it.
 */
export const SWIPE_VIEWS_HORIZONTAL_SCROLL_ATTR =
  "data-swipe-views-horizontal-scroll";

// The pager lives below the shared top-shell spacer. Its gesture surface must
// still fill the remaining viewport when a panel is shorter than the screen;
// `h-full` only inherited the content height and left empty areas unswipeable.
const SWIPE_VIEWPORT_MIN_HEIGHT =
  "calc(100dvh - var(--app-top-content-offset, 0px))";

function isNestedHorizontalScrollTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest(`[${SWIPE_VIEWS_HORIZONTAL_SCROLL_ATTR}]`))
  );
}

function isNestedSwipeViewsTarget(
  target: EventTarget | null,
  rootNode: HTMLElement,
): boolean {
  if (!(target instanceof Element)) return false;
  const closestSwipeViewsRoot = target.closest<HTMLElement>(
    "[data-swipe-views-root='true']",
  );
  return Boolean(closestSwipeViewsRoot && closestSwipeViewsRoot !== rootNode);
}

interface SwipeViewsProps {
  children: React.ReactNode;
  options: readonly { label: string; value: string }[];
  tabSetId: string;
  activeValue: string;
  /** Emits immediately when Embla selects a pane; route state remains authoritative. */
  onSelectionChange?: (value: string) => void;
  /**
   * Emits after the compositor has settled on a pane. Query-backed workspaces
   * use this boundary to update the URL without putting Next navigation in
   * the pointer/scroll hot path.
   */
  onSelectionCommit?: (value: string) => void;
  /** Keeps route content and surface shadows inside the canonical page gutter. */
  panelInset?: "none" | "page";
  /**
   * Opt into a parent-owned vertical viewport. Workspace managers use this
   * when their toolbar and pagination live outside the scrollable row rail.
   */
  viewportMinHeight?: string;
  className?: string;
}

export function SwipeViews({
  children,
  options,
  tabSetId,
  activeValue,
  onSelectionChange,
  onSelectionCommit,
  panelInset = "none",
  viewportMinHeight = SWIPE_VIEWPORT_MIN_HEIGHT,
  className,
}: SwipeViewsProps) {
  const watchDrag = useCallback(
    (emblaApi: EmblaCarouselType, event: Event) =>
      !isNestedHorizontalScrollTarget(event.target) &&
      !isNestedSwipeViewsTarget(event.target, emblaApi.rootNode()),
    [],
  );
  const [emblaRef, emblaApi] = useEmblaCarousel({
    loop: false,
    dragFree: false,
    containScroll: "trimSnaps",
    // Query-backed panes must feel like a direct workspace selection rather
    // than a second route transition. Embla's duration is its spring-like
    // snap parameter (not milliseconds); 16 is deliberately quicker than
    // the default while retaining enough motion for the live tab underline.
    duration: 16,
    dragThreshold: 6,
    skipSnaps: false,
    // Pane content streams, charts, and cached resources change height often.
    // Embla's default ResizeObserver re-initialized the horizontal engine for
    // those vertical-only changes, producing a visible hitch on Finance.
    // Viewport-width changes are handled explicitly below.
    watchResize: false,
    watchDrag,
  });
  const panels = useMemo(() => React.Children.toArray(children), [children]);
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === activeValue),
  );
  const isDraggingRef = useRef(false);
  const hasMovedSincePointerDownRef = useRef(false);
  const lastReportedValueRef = useRef(activeValue);
  const resizeFrameRef = useRef<number | null>(null);

  const syncTabIndicator = useCallback(
    (isDragging?: boolean) => {
      if (!emblaApi) return null;
      const scrollProgress = emblaApi.scrollProgress?.();
      const position =
        typeof scrollProgress === "number" && Number.isFinite(scrollProgress)
          ? scrollProgress * Math.max(0, options.length - 1)
          : emblaApi.selectedScrollSnap();
      setTopShellTabSwipeState(
        tabSetId,
        position,
        isDragging ?? isDraggingRef.current,
      );
      return position;
    },
    [emblaApi, options.length, tabSetId],
  );

  // The route is the selection authority. Page swipes report their new value
  // upward, and shell tab clicks update that same route-backed prop.
  useEffect(() => {
    if (!emblaApi) return;
    const targetIdx = options.findIndex((opt) => opt.value === activeValue);
    if (targetIdx !== -1 && targetIdx !== emblaApi.selectedScrollSnap()) {
      emblaApi.scrollTo(targetIdx);
      setTopShellTabSwipeState(tabSetId, Math.max(0, targetIdx), false);
    } else if (!isDraggingRef.current && !hasMovedSincePointerDownRef.current) {
      setTopShellTabSwipeState(tabSetId, Math.max(0, targetIdx), false);
    }
    lastReportedValueRef.current = activeValue;
  }, [emblaApi, activeValue, options, tabSetId]);

  // Publish selection at Embla's `select` point. Waiting for `settle` made
  // query-backed tabs look stale on iOS and delayed the visible panel state.
  const onSelect = useCallback(() => {
    if (!emblaApi) return;
    const currentIdx = emblaApi.selectedScrollSnap();
    const newValue = options[currentIdx]?.value;
    if (newValue && newValue !== activeValue) {
      lastReportedValueRef.current = newValue;
      onSelectionChange?.(newValue);
    }
  }, [activeValue, emblaApi, onSelectionChange, options]);

  // A settle can only reconcile a snap that changed after selection (for
  // example a cancelled drag); it never owns the first route update.
  const onSettle = useCallback(() => {
    if (!emblaApi) return;
    const currentIdx = emblaApi.selectedScrollSnap();
    // Embla continues its snap after the finger lifts. Keep the tab indicator
    // bound to the same compositor progress through that settle phase instead
    // of letting it jump back to the route-selected index mid-pane motion.
    isDraggingRef.current = false;
    hasMovedSincePointerDownRef.current = false;
    setTopShellTabSwipeState(tabSetId, currentIdx, false);
    const newValue = options[currentIdx]?.value;
    if (newValue && newValue !== lastReportedValueRef.current) {
      lastReportedValueRef.current = newValue;
      onSelectionChange?.(newValue);
    }
    if (newValue) {
      onSelectionCommit?.(newValue);
    }
  }, [emblaApi, options, onSelectionChange, onSelectionCommit, tabSetId]);

  useEffect(() => {
    if (!emblaApi) return;
    let lastWidth = window.innerWidth;
    const onResize = () => {
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        const nextWidth = window.innerWidth;
        if (Math.abs(nextWidth - lastWidth) < 1) return;
        lastWidth = nextWidth;
        emblaApi.reInit();
        syncTabIndicator(false);
      });
    };
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      window.removeEventListener("resize", onResize);
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, [emblaApi, syncTabIndicator]);

  useEffect(() => {
    if (!emblaApi) return;
    return subscribeTopShellTabSelection((selection) => {
      if (selection.tabSetId !== tabSetId) return;
      const targetIndex = options.findIndex(
        (option) => option.value === selection.value,
      );
      if (targetIndex < 0 || targetIndex === emblaApi.selectedScrollSnap())
        return;
      // A top-tab press starts the compositor motion immediately. Waiting for
      // Next searchParams made the tab ink update first and the pane lag behind.
      emblaApi.scrollTo(targetIndex);
    });
  }, [emblaApi, options, tabSetId]);

  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.on("select", onSelect);
    emblaApi.on("settle", onSettle);

    return () => {
      emblaApi.off("select", onSelect);
      emblaApi.off("settle", onSettle);
    };
  }, [emblaApi, onSelect, onSettle]);

  useEffect(() => {
    if (!emblaApi) return;
    const onScroll = () => {
      const position = syncTabIndicator();
      if (
        typeof position === "number" &&
        Math.abs(position - activeIndex) > 0.001
      ) {
        hasMovedSincePointerDownRef.current = true;
      }
    };
    const onPointerDown = () => {
      isDraggingRef.current = true;
      hasMovedSincePointerDownRef.current = false;
      syncTabIndicator(true);
    };
    const onPointerUp = () => {
      // Preserve the progress-driven indicator until Embla settles after a
      // real horizontal move. A tap or vertical intent has no settle motion,
      // so it can return to route-driven state immediately.
      if (hasMovedSincePointerDownRef.current) {
        syncTabIndicator(true);
        return;
      }
      isDraggingRef.current = false;
      syncTabIndicator(false);
    };

    syncTabIndicator(false);
    emblaApi.on("scroll", onScroll);
    emblaApi.on("pointerDown", onPointerDown);
    emblaApi.on("pointerUp", onPointerUp);

    return () => {
      emblaApi.off("scroll", onScroll);
      emblaApi.off("pointerDown", onPointerDown);
      emblaApi.off("pointerUp", onPointerUp);
      isDraggingRef.current = false;
      hasMovedSincePointerDownRef.current = false;
    };
  }, [activeIndex, emblaApi, syncTabIndicator]);

  return (
    <div
      data-swipe-views-root="true"
      data-no-auto-fade="true"
      className={cn("w-full min-h-0 overflow-hidden", className)}
      ref={emblaRef}
      style={{ minHeight: viewportMinHeight }}
    >
      <div
        className="flex w-full min-h-0 touch-pan-y transform-gpu will-change-transform"
        style={{ minHeight: "inherit" }}
      >
        {options.map((option, index) => {
          const isActive = index === activeIndex;
          const safeValue = option.value.replace(/[^a-zA-Z0-9_-]/g, "-");
          return (
            <div
              key={option.value}
              id={`top-shell-${tabSetId}-panel-${safeValue}`}
              role="tabpanel"
              aria-labelledby={`top-shell-${tabSetId}-tab-${safeValue}`}
              aria-hidden={!isActive}
              tabIndex={isActive ? 0 : -1}
              data-swipe-panel-inset={panelInset}
              className={cn(
                "h-full flex-[0_0_100%] min-h-0 min-w-0 max-w-full",
                panelInset === "page" &&
                  "px-[var(--page-inline-gutter-standard)]",
              )}
              style={{ minHeight: "inherit" }}
            >
              {panels[index]}
            </div>
          );
        })}
      </div>
    </div>
  );
}
