"use client";

import {
  useCallback,
  useEffect,
  useState,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";

import type { TopShellTabSet } from "@/lib/navigation/top-shell-tabs";
import {
  hasTopShellTabPager,
  requestTopShellTabSelection,
  setTopShellTabSwipeState,
  topShellTabSwipePositionVariable,
  useTopShellTabSwipeState,
} from "@/lib/navigation/top-shell-tab-swipe-progress";
import { useInteractionIntents } from "@/lib/interaction/interaction-intent-coordinator";
import { beginRouteTransition } from "@/lib/morphy-ux/hooks/use-route-transition";
import { resetKaiBottomChromeVisibility } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { scrollAppToTop } from "@/lib/navigation/use-scroll-reset";
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
  // Query tabs swap content inside one route. RIA retains durable pathname
  // routes, but its `/ria` layout owns a persistent identity shell, so its
  // tab switch uses the same no-envelope contextual commit as Location. The
  // route page below that shell may change; the shell itself must not fade or
  // translate with it.
  const transitionMode =
    tabSet.id === "ria"
      ? "contextual"
      : tabSet.queryParam === null
        ? "full"
        : "contextual";
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
  const usesModuleSegmentedTabs =
    tabSet.id === "location" ||
    tabSet.id === "connect" ||
    tabSet.id === "consent" ||
    tabSet.id === "ria";
  const usesCompactLabels = usesModuleSegmentedTabs && tabSet.tabs.length > 3;
  const shouldResetScrollOnSelection = tabSet.id === "finance";

  const textRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [activeTextWidth, setActiveTextWidth] = useState(0);

  useEffect(() => {
    const activeTextSpan = textRefs.current[activeIndex];
    if (activeTextSpan) {
      setActiveTextWidth(activeTextSpan.offsetWidth);
    }
  }, [activeIndex, tabSet.tabs.length]);

  // Keep the shared swipe-position variable in sync with the committed active
  // tab. Taps go through `selectIndex`, which already snaps the indicator, but
  // when the active tab changes by any other path -- a deep link like
  // `?tab=history`, a back/forward navigation, or external route state -- the
  // persisted position variable can retain the PREVIOUS index. The transform
  // only falls back to `activeIndex` while that variable is unset, so a stale
  // value would leave the underline resting under the wrong tab until the next
  // tap. Re-sync here (never while the pager owns the variable) so the resting
  // indicator always matches the selected tab, and no-op when already aligned.
  useEffect(() => {
    if (tabSwipeState.pagerOwned) return;
    if (Math.abs(tabSwipeState.position - activeIndex) < 0.001) return;
    setTopShellTabSwipeState(tabSet.id, activeIndex, false);
  }, [activeIndex, tabSet.id, tabSwipeState.pagerOwned, tabSwipeState.position]);

  const selectIndex = useCallback(
    (index: number, focus: boolean) => {
      const tab = tabSet.tabs[index];
      if (!tab) return;
      if (focus) tabRefs.current[index]?.focus();
      if (tab.value === selectedValue) return;

      // Move the shared compositor indicator at pointer/keyboard time. The
      // query-backed route remains the semantic authority, but it must not
      // delay or replay the visible tab response.
      //
      // Skipped where a pager is mounted, because there this write was the
      // first half of a two-writer race: it set the destination and started a
      // 240ms transition, and the pager then overwrote the same variable with
      // live scroll progress on every frame of it. The panel landed at ~400ms
      // and the pill was still creeping at ~600ms. `requestTopShellTabSelection`
      // below reaches the pager in this same tick, so the pill still starts
      // moving on the very next frame -- it just starts from the panel's real
      // position and stays welded to it.
      if (!hasTopShellTabPager(tabSet.id)) {
        setTopShellTabSwipeState(tabSet.id, index, false);
      }
      requestTopShellTabSelection(tabSet.id, tab.value);
      beginRouteTransition(
        tab.href,
        () => {
          if (shouldResetScrollOnSelection) {
            scrollAppToTop();
            resetKaiBottomChromeVisibility();
          }
          if (navigationMode === "push") {
            router.push(
              tab.href,
              shouldResetScrollOnSelection ? undefined : { scroll: false },
            );
            return;
          }
          router.replace(
            tab.href,
            shouldResetScrollOnSelection ? undefined : { scroll: false },
          );
        },
        "tap",
        transitionMode,
      );
    },
    [
      navigationMode,
      router,
      selectedValue,
      shouldResetScrollOnSelection,
      tabSet,
      transitionMode,
    ],
  );

  return (
    <div
      className={cn(
        "top-shell-ambient-ink relative flex h-[var(--top-tabs-h)] w-full items-center text-current",
        usesModuleSegmentedTabs && "justify-center",
      )}
      data-ui-role="agent-tab-bar"
      data-top-shell-tab-set={tabSet.id}
      style={
        {
          [topShellTabSwipePositionVariable(tabSet.id)]: tabSwipeState.position,
        } as CSSProperties
      }
    >
      <div
        aria-label={`${tabSet.label} navigation`}
        className={cn(
          "relative flex",
          usesModuleSegmentedTabs
            ? // Same edges as the cards under it, at every width.
              //
              // This carried `mx-5` on top of the frame's own
              // `px-[var(--page-inline-gutter-standard)]`, so it paid the page
              // gutter twice and sat 40px narrower than the grouped cards on
              // EVERY phone — 36px from the edge against their 16px. And it
              // capped at 720px, a number belonging to nothing else here, while
              // the Location column is 880px: 104-112px short on desktop.
              //
              // The cap is now the page column's own content width, so the two
              // cannot drift apart again. Both tokens already exist. Scoped to
              // Location, Connect, Consent, and RIA by the module branch above — the
              // other tab sets take the underline arm and do not move.
              //
              // RIA joined 2026-09 (#6289's follow-up): this wrapper carries
              // no outer width constraint of its own (see top-app-bar.tsx),
              // so the `--app-shell-agent` cap here is the only one that
              // applies — same as Location. RIA Picks' own content already
              // renders at that same width (`width="agent"` on its
              // AppPageShell), so this does not narrow anything RIA already
              // shows wider. Verified by rendering the component directly
              // (no authenticated route reachable locally without reviewer
              // credentials) at desktop and mobile widths against Location
              // side by side.
              "h-9 w-full max-w-[calc(var(--app-shell-agent)-2*var(--page-inline-gutter-standard))] rounded-[10px] bg-[color:var(--app-neutral-fill)] p-0.5"
            : "h-full w-full",
        )}
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
              data-ui-role="agent-tab"
              data-voice-control-id={
                tabSet.id === "ria" ? `ria_route_tab_${tab.value}` : undefined
              }
              aria-controls={topShellTabDomId(tabSet, "panel", tab.value)}
              aria-selected={isActive}
              aria-current={isActive ? "page" : undefined}
              tabIndex={isActive ? 0 : -1}
              className={cn(
                "relative z-10 flex h-full flex-1 items-center justify-center px-3 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] focus-visible:ring-inset",
                usesCompactLabels && "min-w-0 px-0.5 sm:px-3",
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
                ref={(node) => {
                  textRefs.current[index] = node;
                }}
                data-ui-role="agent-tab-label"
                className={cn(
                  "ui-text-agent-tab-label relative truncate transition-colors duration-150",
                  usesCompactLabels &&
                    "[--type-agent-tab-label-size:11px] min-[360px]:[--type-agent-tab-label-size:12px] min-[400px]:[--type-agent-tab-label-size:14px] sm:[--type-agent-tab-label-size:15px]",
                  usesModuleSegmentedTabs
                    ? isActive
                      ? "font-semibold text-[color:var(--app-accent)]"
                      : "font-medium text-[color:var(--app-secondary-label)] hover:text-[color:var(--app-label)]"
                    : isActive
                      ? "text-[color:var(--app-accent)]"
                      : "text-[color:var(--app-label)] hover:text-current",
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
              "pointer-events-none absolute left-0 flex justify-center motion-reduce:transition-none",
              usesModuleSegmentedTabs
                ? "inset-y-0.5 z-0"
                : "bottom-0 z-20",
              // While the pager owns the variable -- a finger on it, or a
              // tapped panel in flight -- the pill IS the panel's position and
              // must track it frame for frame. A transition here would be a
              // second animation chasing the first, retargeted every frame.
              tabSwipeState.pagerOwned
                ? "transition-none"
                : "transition-transform duration-[240ms] ease-[cubic-bezier(0.32,0.72,0,1)]",
            )}
            style={{
              transform: indicatorTransform,
              width: tabWidth,
            }}
          >
            <span
              className={cn(
                "transition-[width] duration-150",
                usesModuleSegmentedTabs
                  ? "h-full w-[calc(100%-4px)] rounded-[8px] bg-[color:var(--app-card-surface-default-solid)] shadow-[0_1px_2px_rgba(0,0,0,0.10)]"
                  : "h-[3px] rounded-full bg-[var(--app-accent)]",
              )}
              style={{
                width: usesModuleSegmentedTabs
                  ? undefined
                  : activeTextWidth
                    ? `${Math.max(28, activeTextWidth)}px`
                    : "max(28px, calc(100% - 2rem))",
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
