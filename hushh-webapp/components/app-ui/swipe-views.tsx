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
export const SWIPE_VIEWS_HORIZONTAL_SCROLL_ATTR = "data-swipe-views-horizontal-scroll";

function isNestedHorizontalScrollTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(
    target.closest(`[${SWIPE_VIEWS_HORIZONTAL_SCROLL_ATTR}]`),
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
    (_emblaApi: unknown, event: Event) => !isNestedHorizontalScrollTarget(event.target),
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

  const syncTabIndicator = useCallback(
    (isDragging?: boolean) => {
      if (!emblaApi) return;
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

  // Setup embla listeners
  const onSelect = useCallback(() => {
    if (!emblaApi) return;
    const currentIdx = emblaApi.selectedScrollSnap();
    const newValue = options[currentIdx]?.value;
    if (newValue && newValue !== activeValue) {
      onChildSwiped?.(newValue);
    }
  }, [emblaApi, options, activeValue, onChildSwiped]);

  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.on("select", onSelect);

    return () => {
      emblaApi.off("select", onSelect);
    };
  }, [emblaApi, onSelect]);

  useEffect(() => {
    if (!emblaApi) return;
    const onScroll = () => syncTabIndicator();
    const onPointerDown = () => {
      isDraggingRef.current = true;
      syncTabIndicator(true);
    };
    const onPointerUp = () => {
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
    };
  }, [emblaApi, syncTabIndicator]);

  return (
    <div className="overflow-hidden w-full h-full" ref={emblaRef}>
      <div className="flex w-full h-full touch-pan-y">
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
              className="flex-[0_0_100%] min-w-0 h-full"
            >
              {isActive ? panels[index] : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
