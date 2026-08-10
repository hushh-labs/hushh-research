"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";

import type { TopShellTabSet } from "@/lib/navigation/top-shell-tabs";
import {
  requestTopShellTabSelection,
  setTopShellTabSwipeState,
  topShellTabSwipePositionVariable,
  useTopShellTabSwipeState,
} from "@/lib/navigation/top-shell-tab-swipe-progress";
import { useInteractionIntents } from "@/lib/interaction/interaction-intent-coordinator";
import { beginRouteTransition } from "@/lib/morphy-ux/hooks/use-route-transition";
import { cn } from "@/lib/utils";

function topShellTabDomId(
  tabSet: Pick<TopShellTabSet, "id">,
  kind: "tab" | "panel",
  value: string,
): string {
  return `top-shell-${tabSet.id}-${kind}-${value.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/**
 * Shared contextual tabs for the Morphy top app bar and public knowledge
 * pages. Route ownership stays with each caller; this component owns only
 * the visual, keyboard, and selected-tab contract.
 */
export function TopShellTabs({
  tabSet,
  navigationMode = "replace",
}: {
  tabSet: TopShellTabSet;
  navigationMode?: "push" | "replace";
}) {
  const router = useRouter();
  const interactionIntents = useInteractionIntents();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Query tabs swap content inside one route. Route-backed workspaces (RIA)
  // own distinct durable screens and therefore use the single full route
  // envelope for both taps and swipes.
  const transitionMode =
    tabSet.queryParam === null ? "full" : "contextual";
  const optimisticValue = useMemo(() => {
    const activeIntent = [...interactionIntents]
      .reverse()
      .find(
        (intent) =>
          intent.kind === "navigation" &&
          intent.transitionMode === transitionMode &&
          (intent.status === "accepted" || intent.status === "committing") &&
          tabSet.tabs.some((tab) => tab.href === intent.target),
      );
    return activeIntent
      ? tabSet.tabs.find((tab) => tab.href === activeIntent.target)?.value
      : null;
  }, [interactionIntents, tabSet.tabs, transitionMode]);
  const selectedValue = optimisticValue ?? tabSet.activeValue;
  const activeIndex = Math.max(
    0,
    tabSet.tabs.findIndex((tab) => tab.value === selectedValue),
  );
  // A single-entry tab set has nothing to switch between, so the sliding
  // pill and accent underline (both designed to show which of several
  // segments is active) would otherwise render as one meaningless
  // full-width bar. Skip the decorative indicators in that case.
  const showIndicators = tabSet.tabs.length > 1;
  const tabWidth = `${100 / tabSet.tabs.length}%`;
  const tabSwipeState = useTopShellTabSwipeState(tabSet.id);
  const indicatorTransform = `translate3d(calc(var(${topShellTabSwipePositionVariable(tabSet.id)}, ${activeIndex}) * 100%), 0, 0)`;

  // Keep the shared swipe-position variable in sync with the committed active
  // tab. Taps go through `selectIndex`, which already snaps the indicator, but
  // when the active tab changes by any other path -- a deep link like
  // `?tab=history`, a back/forward navigation, or external route state -- the
  // persisted position variable can retain the PREVIOUS index. The transform
  // only falls back to `activeIndex` while that variable is unset, so a stale
  // value would leave the underline resting under the wrong tab until the next
  // tap. Re-sync here (never mid-drag) so the resting indicator always matches
  // the selected tab. Inert during drags and no-op when already aligned.
  useEffect(() => {
    if (tabSwipeState.isDragging) return;
    if (Math.abs(tabSwipeState.position - activeIndex) < 0.001) return;
    setTopShellTabSwipeState(tabSet.id, activeIndex, false);
  }, [activeIndex, tabSet.id, tabSwipeState.isDragging, tabSwipeState.position]);

  const selectIndex = useCallback(
    (index: number, focus: boolean) => {
      const tab = tabSet.tabs[index];
      if (!tab) return;
      if (focus) tabRefs.current[index]?.focus();
      if (tab.value === selectedValue) return;

      // Move the shared compositor indicator at pointer/keyboard time. The
      // query-backed route remains the semantic authority, but it must not
      // delay or replay the visible tab response.
      setTopShellTabSwipeState(tabSet.id, index, false);
      requestTopShellTabSelection(tabSet.id, tab.value);
      beginRouteTransition(
        tab.href,
        () => {
          if (navigationMode === "push") {
            router.push(tab.href, { scroll: false });
            return;
          }
          router.replace(tab.href, { scroll: false });
        },
        "tap",
        transitionMode,
      );
    },
    [navigationMode, router, selectedValue, tabSet, transitionMode],
  );

  return (
    <div
      className="top-shell-ambient-ink relative flex h-[var(--top-tabs-h)] w-full items-center text-current"
      data-top-shell-tab-set={tabSet.id}
      style={
        {
          [topShellTabSwipePositionVariable(tabSet.id)]: tabSwipeState.position,
        } as CSSProperties
      }
    >
      <div
        aria-label={`${tabSet.label} navigation`}
        className="relative flex h-full w-full"
        role="tablist"
      >
        {tabSet.tabs.map((tab, index) => {
          const isActive = tab.value === selectedValue;
          return (
            <button
              key={tab.value}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              id={topShellTabDomId(tabSet, "tab", tab.value)}
              type="button"
              role="tab"
              data-voice-control-id={
                tabSet.id === "ria" ? `ria_route_tab_${tab.value}` : undefined
              }
              aria-controls={topShellTabDomId(tabSet, "panel", tab.value)}
              aria-selected={isActive}
              aria-current={isActive ? "page" : undefined}
              tabIndex={isActive ? 0 : -1}
              className={cn(
                "relative z-10 flex h-full flex-1 items-center justify-center px-3 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] focus-visible:ring-inset",
              )}
              onClick={() => selectIndex(index, false)}
              onKeyDown={(event) => {
                let nextIndex: number | null = null;
                if (event.key === "ArrowRight") {
                  nextIndex = (index + 1) % tabSet.tabs.length;
                } else if (event.key === "ArrowLeft") {
                  nextIndex =
                    (index - 1 + tabSet.tabs.length) % tabSet.tabs.length;
                } else if (event.key === "Home") {
                  nextIndex = 0;
                } else if (event.key === "End") {
                  nextIndex = tabSet.tabs.length - 1;
                }
                if (nextIndex === null) return;
                event.preventDefault();
                selectIndex(nextIndex, true);
              }}
            >
              <span
                className={cn(
                  "ui-text-form-label relative truncate transition-colors duration-150",
                  isActive
                    ? "font-semibold text-current"
                    : "font-normal text-[color:var(--app-secondary-label)] hover:text-current",
                )}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
        {showIndicators ? (
          <div
            aria-hidden
            data-testid="top-shell-tab-indicator"
            className={cn(
              "pointer-events-none absolute bottom-0 left-0 z-20 flex justify-center motion-reduce:transition-none",
              tabSwipeState.isDragging
                ? "transition-none"
                : "transition-transform duration-[240ms] ease-[cubic-bezier(0.32,0.72,0,1)]",
            )}
            style={{
              transform: indicatorTransform,
              width: tabWidth,
            }}
          >
            <span className="h-[2.5px] w-[max(28px,calc(100%-2rem))] rounded-full bg-[var(--app-accent)]" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
