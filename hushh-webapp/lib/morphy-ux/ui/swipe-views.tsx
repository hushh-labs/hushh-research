"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EmblaCarouselType } from "embla-carousel";
import useEmblaCarousel from "embla-carousel-react";

import {
  setTopShellTabSwipeState,
  subscribeTopShellTabSelection,
} from "@/lib/navigation/top-shell-tab-swipe-progress";
import { VoiceSurfaceActivityBoundary } from "@/lib/voice/voice-surface-activity";
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

/**
 * Embla's own `scrollSnaps` can desync from its `slideRects` after certain
 * reInit/resize sequences: slideRects correctly reports N uniform-width
 * slides, but scrollSnaps keeps a shorter array from an earlier measurement
 * (observed directly: slideRects = [792, 792, 792], scrollSnaps = [0, -168]).
 * Patching scrollSnaps back in sync (used below, and by Embla's own drag
 * snapping) is necessary but not sufficient: `scrollTo(index)` resolves an
 * index through `indexCurrent.clone().set(index)` first, and that Counter's
 * upper bound is captured once at construction from the *original* (stale)
 * scrollSnaps length. It has no public setter, so a request for an index
 * beyond that stale bound is silently clamped down before the distance is
 * even computed -- observed directly: scrollTo(2) on a carousel whose Counter
 * still thinks max=1 computed a target of -792 (index 1's snap) instead of
 * -1584 (index 2's), because byIndex() only ever saw the clamped index.
 * There is no way to fix that bound from outside, so after asking Embla to
 * scroll, force the actual position to the correct absolute pixel computed
 * independently from slideRects, which we've confirmed stays accurate.
 */
function scrollToIndexSafely(
  api: EmblaCarouselType,
  index: number,
  jump?: boolean,
) {
  const engine = api.internalEngine?.();
  const slideRects = engine?.slideRects;
  const slideWidth = slideRects?.[0]?.width;
  const hasReliableWidth =
    typeof slideWidth === "number" && slideWidth > 0 && Boolean(slideRects?.length);

  // The engine's `limit` (its scroll bounds) is captured at construction from
  // the same stale measurement as scrollSnaps, and has no public setter. Its
  // rubber-band edge logic (ScrollBounds.constrain, run every animation
  // frame) treats any position beyond that stale limit as an out-of-bounds
  // overscroll and pulls the target back toward it -- observed directly:
  // forcing target to index 2's real position still settled back near 0,
  // because the animation loop kept fighting it back within the old bound.
  // Disabling it is safe here: the bound it would otherwise protect is wrong
  // for the carousel's real content, not a legitimate edge.
  engine?.scrollBounds?.toggleActive?.(false);

  if (engine && hasReliableWidth) {
    const expected = slideRects.map((_, i) => -(i * slideWidth));
    const current = engine.scrollSnaps;
    const isStale =
      current.length !== expected.length ||
      expected.some((value, i) => Math.abs((current[i] ?? NaN) - value) > 1);
    if (isStale) {
      current.splice(0, current.length, ...expected);
    }
  }

  if (jump) {
    api.scrollTo(index, jump);
  } else {
    api.scrollTo(index);
  }

  if (engine && hasReliableWidth) {
    const correctTarget = -(index * slideWidth);
    engine.target.set(correctTarget);
    if (jump) {
      engine.location.set(correctTarget);
      engine.offsetLocation.set(correctTarget);
      engine.previousLocation.set(correctTarget);
      engine.translate.to(correctTarget);
    } else {
      engine.animation.start();
    }
  }
}

/**
 * Embla's own `selectedScrollSnap()` reads through the same stale-bounded
 * Counter documented above, so it can misreport the current pane even after
 * `scrollToIndexSafely` has corrected the actual rendered position --
 * observed directly: forcing a scroll to index 2 lands the pane on the
 * correct pixel, but the 'settle' event that follows still reports index 1,
 * which this component then propagated upward as a silent revert of the
 * user's own selection back to index 1. Resolve the effective index from the
 * real rendered position instead, which we've confirmed stays accurate; only
 * fall back to Embla's own counter when the geometry isn't available yet
 * (e.g. before first layout).
 */
function resolveVisualIndex(api: EmblaCarouselType, optionsLength: number): number {
  const engine = api.internalEngine?.();
  const slideWidth = engine?.slideRects?.[0]?.width;
  const rendered = engine?.offsetLocation?.get?.();
  if (
    engine &&
    typeof slideWidth === "number" &&
    slideWidth > 0 &&
    typeof rendered === "number" &&
    optionsLength > 0
  ) {
    const rawIndex = Math.round(-rendered / slideWidth);
    return Math.min(Math.max(rawIndex, 0), optionsLength - 1);
  }
  return api.selectedScrollSnap();
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
  /**
   * Defaults to max content height so mounted panes can keep their existing
   * layout. Compact task panes can opt into the active pane's measured height.
   */
  heightMode?: "max" | "active";
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
  heightMode = "max",
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
    // Embla's default ResizeObserver reacts to every observed target -- the
    // container AND each individual slide -- so that frequent per-slide
    // height churn re-triggered the horizontal engine and produced a visible
    // hitch on Finance. But disabling it outright (the previous fix) meant
    // Embla's cached container width goes stale the moment it drifts from
    // its value at mount (font load, sidebar/app-shell chrome settling, a
    // scrollbar appearing) and never self-corrects, since the window-resize
    // fallback below only fires on actual browser-window resizes. A stale
    // width makes every later scrollTo() land at a fraction of a real slide
    // width instead of a clean multiple of it -- the two panes then render
    // partially overlapped rather than one fully off-screen. Scoping the
    // watcher to entries whose target is the container itself keeps it
    // width-accurate against ANY resize cause while still ignoring the
    // per-slide entries that caused the original hitch.
    watchResize: (emblaApiInstance, entries) =>
      entries.some((entry) => entry.target === emblaApiInstance.containerNode()),
    watchDrag,
  });
  const panels = useMemo(() => React.Children.toArray(children), [children]);
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === activeValue),
  );
  const panelNodesRef = useRef<Record<string, HTMLDivElement | null>>({});
  const [activePanelHeight, setActivePanelHeight] = useState<number | null>(null);
  const isDraggingRef = useRef(false);
  const hasMovedSincePointerDownRef = useRef(false);
  const lastReportedValueRef = useRef(activeValue);
  const resizeFrameRef = useRef<number | null>(null);
  // Read by the measurement-reconciliation effect below, which must not itself
  // re-run on every selection change (re-subscribing its observer each time),
  // but still needs the CURRENT selection whenever it does fire.
  const activeValueRef = useRef(activeValue);
  const optionsRef = useRef(options);
  useEffect(() => {
    activeValueRef.current = activeValue;
    optionsRef.current = options;
  }, [activeValue, options]);

  useEffect(() => {
    if (heightMode !== "active") {
      setActivePanelHeight(null);
      return;
    }

    const activeNode = panelNodesRef.current[activeValue];
    if (!activeNode) return;

    let frame = 0;
    const measure = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const nextHeight = Math.ceil(activeNode.scrollHeight);
        setActivePanelHeight((current) =>
          current === nextHeight ? current : nextHeight,
        );
      });
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure, { passive: true });
      return () => {
        if (frame) window.cancelAnimationFrame(frame);
        window.removeEventListener("resize", measure);
      };
    }

    const observer = new ResizeObserver(measure);
    observer.observe(activeNode);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeValue, heightMode]);

  // Embla measures the container and slides synchronously at init, but only
  // attaches its own ResizeObserver a frame later. A width change inside that
  // gap is never observed -- the observer takes the NEW width as its baseline
  // while the engine keeps the stale one -- so its snap points stay wrong
  // permanently, and nothing further fires to repair them.
  //
  // The visible result is a pane resting at a fraction of a slide width rather
  // than a clean multiple of it, leaving two panes overlapped on screen.
  //
  // Checking only whether the measured width looks stale is not enough: the
  // engine can re-measure correctly and still leave the rendered transform
  // parked in the wrong place, in which case a width-only check sees nothing
  // wrong and skips the repair. So assert the symptom itself -- is the pane
  // that is supposed to be showing actually the one in view -- and reconcile
  // whenever it is not. That is self-healing regardless of when, or why, the
  // position drifted.
  useEffect(() => {
    if (!emblaApi) return;
    const api = emblaApi;
    const root = api.rootNode();
    let lastWidth = -1;

    const reconcile = () => {
      // Never fight a finger that is mid-drag; Embla owns the position then.
      if (isDraggingRef.current) return;

      const width = root.getBoundingClientRect().width;
      // A hidden/unlaid-out pane measures 0; re-measuring against that would
      // bake in a worse value than whatever is already held.
      if (width <= 0) return;

      const engine = api.internalEngine?.();
      const engineWidth = engine?.containerRect?.width;
      const widthChanged = lastWidth !== -1 && Math.abs(width - lastWidth) > 0.5;
      const engineIsStale =
        typeof engineWidth === "number" && Math.abs(engineWidth - width) > 1;
      lastWidth = width;

      // Embla registers its slide list from the container's DOM children at
      // init time and re-syncs it via its own MutationObserver (`watchSlides`).
      // That sync can race a panel that mounts a beat after Embla's own init
      // (for example a tab that only appears once a computed flag settles):
      // slideRects gets remeasured, but scrollSnaps -- the actual snap-point
      // list scrollTo() targets -- can be left stuck at the stale, smaller
      // count. Embla then keeps scrolling and reporting a perfectly
      // self-consistent position, just against snap points computed for a
      // carousel with fewer slides than are actually in the DOM. A width or
      // slideRects check can't see this -- neither changed, only scrollSnaps
      // failed to grow with the container's real children.
      const containerChildCount = api.containerNode?.().children.length;
      const engineSnapCount = engine?.scrollSnaps?.length;
      const slideCountStale =
        typeof containerChildCount === "number" &&
        typeof engineSnapCount === "number" &&
        containerChildCount !== engineSnapCount;

      const targetIdx = optionsRef.current.findIndex(
        (opt) => opt.value === activeValueRef.current,
      );

      // Where the pane is trying to go, against where the selected pane belongs.
      // Checking `target` instead of `offsetLocation` allows normal animations
      // to proceed without being aborted as "misaligned" mid-flight.
      const targetAt = engine?.target?.get?.();
      const belongsAt = engine?.scrollSnaps?.[targetIdx];
      const misaligned =
        targetIdx !== -1 &&
        typeof targetAt === "number" &&
        typeof belongsAt === "number" &&
        Math.abs(targetAt - belongsAt) > 1;

      if (!widthChanged && !engineIsStale && !slideCountStale && !misaligned) return;

      // Re-measure only when the measurement is the thing at fault; reInit()
      // preserves whatever index the engine believes it is on, which may
      // itself have drifted, so re-assert the app's selection either way --
      // jumping rather than animating, so the repair is never itself visible.
      if (widthChanged || engineIsStale || slideCountStale) api.reInit();
      if (targetIdx !== -1) {
        scrollToIndexSafely(api, targetIdx, true);
      }
    };

    reconcile();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reconcile);
    observer.observe(root);
    return () => observer.disconnect();
  }, [emblaApi]);

  const syncTabIndicator = useCallback(
    (isDragging?: boolean) => {
      if (!emblaApi) return null;
      const scrollProgress = emblaApi.scrollProgress?.();
      const position =
        typeof scrollProgress === "number" && Number.isFinite(scrollProgress)
          ? scrollProgress * Math.max(0, options.length - 1)
          : resolveVisualIndex(emblaApi, options.length);
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
    const visualIdx = resolveVisualIndex(emblaApi, options.length);
    if (targetIdx !== -1 && targetIdx !== visualIdx) {
      scrollToIndexSafely(emblaApi, targetIdx);
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
    const currentIdx = resolveVisualIndex(emblaApi, options.length);
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
    const currentIdx = resolveVisualIndex(emblaApi, options.length);
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
    const root = emblaApi.rootNode();
    const measure = () =>
      root ? root.getBoundingClientRect().width : window.innerWidth;
    let lastWidth = measure();

    const scheduleReInit = (nextWidth: number) => {
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        // Width is the only dimension the horizontal engine measures. Ignoring
        // height is what keeps streaming pane content from re-initialising the
        // engine — the Finance hitch `watchResize: false` was set to avoid.
        if (Math.abs(nextWidth - lastWidth) < 1) return;
        lastWidth = nextWidth;
        emblaApi.reInit();
        syncTabIndicator(false);
      });
    };

    // Observe the viewport, not the window. The container can narrow while
    // `window.innerWidth` never changes — a vertical scrollbar appearing as
    // pane content streams in, or a parent transform settling. Embla then
    // keeps a stale width and translates by the wrong distance, leaving the
    // previous pane clipped beside the selected one (Memory /one/pkm).
    const observer =
      root && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            scheduleReInit(entry.contentRect?.width ?? measure());
          })
        : null;
    observer?.observe(root as Element);

    // Only needed where ResizeObserver is unavailable; the observer already
    // catches window resizes, since they resize the container too.
    const onWindowResize = observer ? null : () => scheduleReInit(measure());
    if (onWindowResize) {
      window.addEventListener("resize", onWindowResize, { passive: true });
    }

    return () => {
      observer?.disconnect();
      if (onWindowResize) {
        window.removeEventListener("resize", onWindowResize);
      }
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
      if (targetIndex < 0 || targetIndex === resolveVisualIndex(emblaApi, options.length))
        return;
      // A top-tab press starts the compositor motion immediately. Waiting for
      // Next searchParams made the tab ink update first and the pane lag behind.
      scrollToIndexSafely(emblaApi, targetIndex);
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
      data-swipe-views-height-mode={heightMode}
      data-no-auto-fade="true"
      className={cn("w-full min-h-0 overflow-hidden", className)}
      ref={emblaRef}
      style={{
        minHeight: viewportMinHeight,
        ...(heightMode === "active" && activePanelHeight !== null
          ? { height: activePanelHeight }
          : null),
      }}
    >
      <div
        className={cn(
          "flex w-full min-h-0 touch-pan-y transform-gpu will-change-transform",
          heightMode === "active" && "items-start",
        )}
        style={{ minHeight: "inherit" }}
      >
        {options.map((option, index) => {
          const isActive = index === activeIndex;
          const safeValue = option.value.replace(/[^a-zA-Z0-9_-]/g, "-");
          return (
            <div
              key={option.value}
              ref={(node) => {
                panelNodesRef.current[option.value] = node;
              }}
              id={`top-shell-${tabSetId}-panel-${safeValue}`}
              role="tabpanel"
              aria-labelledby={`top-shell-${tabSetId}-tab-${safeValue}`}
              aria-hidden={!isActive}
              tabIndex={isActive ? 0 : -1}
              data-swipe-panel-inset={panelInset}
              className={cn(
                "flex-[0_0_100%] min-h-0 min-w-0 max-w-full",
                heightMode === "active" ? "h-auto" : "h-full",
                panelInset === "page" &&
                  "px-[var(--page-inline-gutter-standard)]",
              )}
              style={{ minHeight: "inherit" }}
            >
              {/* Every panel stays mounted, so a backgrounded one must not
                  publish itself as the screen the person is on. */}
              <VoiceSurfaceActivityBoundary active={isActive}>
                {panels[index]}
              </VoiceSurfaceActivityBoundary>
            </div>
          );
        })}
      </div>
    </div>
  );
}
