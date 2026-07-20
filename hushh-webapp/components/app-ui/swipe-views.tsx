"use client";

import React, { useCallback, useEffect, useMemo, useRef } from "react";
import useEmblaCarousel from "embla-carousel-react";

import { setTopShellTabSwipeState } from "@/lib/navigation/top-shell-tab-swipe-progress";

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

interface SwipeViewsProps {
  children: React.ReactNode;
  options: readonly { label: string; value: string }[];
  tabSetId: string;
  activeValue: string;
  onChildSwiped?: (value: string) => void;
}

export function SwipeViews({
  children,
  options,
  tabSetId,
  activeValue,
  onChildSwiped,
}: SwipeViewsProps) {
  const watchDrag = useCallback(
    (_emblaApi: unknown, event: Event) =>
      !isNestedHorizontalScrollTarget(event.target),
    [],
  );
  const [emblaRef, emblaApi] = useEmblaCarousel({
    loop: false,
    dragFree: false,
    containScroll: "trimSnaps",
    watchDrag,
  });
  const panels = useMemo(() => React.Children.toArray(children), [children]);
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === activeValue),
  );
  const isDraggingRef = useRef(false);
  const hasMovedSincePointerDownRef = useRef(false);

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
    }
    setTopShellTabSwipeState(tabSetId, Math.max(0, targetIdx), false);
  }, [emblaApi, activeValue, options, tabSetId]);

  // Commit the route only after Embla has settled. Selecting a snap happens
  // while the rail is still moving; committing there mounted a heavy Finance
  // panel (and its data/effects) in the same frame as the gesture.
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
    if (newValue && newValue !== activeValue) {
      onChildSwiped?.(newValue);
    }
  }, [emblaApi, options, activeValue, onChildSwiped, tabSetId]);

  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.on("settle", onSettle);

    return () => {
      emblaApi.off("settle", onSettle);
    };
  }, [emblaApi, onSettle]);

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
      className="w-full min-h-0 overflow-hidden"
      ref={emblaRef}
      style={{ minHeight: SWIPE_VIEWPORT_MIN_HEIGHT }}
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
              className="flex-[0_0_100%] min-h-0 min-w-0"
              style={{ minHeight: "inherit" }}
            >
              {isActive ? panels[index] : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
