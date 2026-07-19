"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

import type { TopShellTabSet } from "@/lib/navigation/top-shell-tabs";
import {
  topShellTabSwipePositionVariable,
  useTopShellTabSwipeState,
} from "@/lib/navigation/top-shell-tab-swipe-progress";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
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
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(
    0,
    tabSet.tabs.findIndex((tab) => tab.value === tabSet.activeValue),
  );
  const tabWidth = `${100 / tabSet.tabs.length}%`;
  const tabSwipeState = useTopShellTabSwipeState(tabSet.id);
  const indicatorTransform = tabSwipeState.isDragging
    ? `translate3d(calc(var(${topShellTabSwipePositionVariable(tabSet.id)}, ${activeIndex}) * 100%), 0, 0)`
    : `translate3d(${activeIndex * 100}%, 0, 0)`;

  const selectIndex = useCallback(
    (index: number, focus: boolean) => {
      const tab = tabSet.tabs[index];
      if (!tab) return;
      if (focus) tabRefs.current[index]?.focus();
      if (tab.value === tabSet.activeValue) return;

      if (navigationMode === "push") {
        router.push(tab.href, { scroll: false });
        return;
      }
      router.replace(tab.href, { scroll: false });
    },
    [navigationMode, router, tabSet],
  );

  return (
    <div className="relative flex h-[var(--top-tabs-h)] w-full items-center">
      <div
        aria-label={`${tabSet.label} navigation`}
        className="relative flex h-full w-full"
        role="tablist"
      >
        {tabSet.tabs.map((tab, index) => {
          const isActive = tab.value === tabSet.activeValue;
          return (
            <button
              key={tab.value}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              id={topShellTabDomId(tabSet, "tab", tab.value)}
              type="button"
              role="tab"
              aria-controls={topShellTabDomId(tabSet, "panel", tab.value)}
              aria-selected={isActive}
              aria-current={isActive ? "page" : undefined}
              tabIndex={isActive ? 0 : -1}
              className={cn(
                "relative flex h-full flex-1 items-center justify-center overflow-hidden transition-colors",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
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
              <MaterialRipple variant="none" className="z-0" />
              <span className="relative z-10 text-[15px] font-medium tracking-tight">
                {tab.label}
              </span>
            </button>
          );
        })}
        <div
          aria-hidden
          data-testid="top-shell-tab-indicator"
          className={cn(
            "absolute bottom-0 left-0 h-[2px] bg-[var(--app-accent)] shadow-[0_1px_10px_color-mix(in_oklab,var(--app-accent)_45%,transparent)] motion-reduce:transition-none",
            tabSwipeState.isDragging
              ? "transition-none"
              : "transition-transform duration-200",
          )}
          style={{
            transform: indicatorTransform,
            width: tabWidth,
          }}
        />
      </div>
    </div>
  );
}
