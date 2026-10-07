"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { SettingsPresentationProvider } from "@/components/app-ui/settings-ui";
import { PageHeader } from "@/components/app-ui/page-sections";
import { cn } from "@/lib/utils";

const STACK_TRANSITION_MS = 150;

export type ProfileStackEntry = {
  key: string;
  title: ReactNode;
  description?: ReactNode;
  content: ReactNode;
  presentation?: "default" | "account";
};

function screensMatch(left: ProfileStackEntry[], right: ProfileStackEntry[]) {
  if (left.length !== right.length) return false;
  return left.every((screen, index) => {
    const candidate = right[index];
    if (!candidate) return false;
    return (
      screen.key === candidate.key &&
      String(screen.title) === String(candidate.title) &&
      String(screen.description || "") === String(candidate.description || "")
    );
  });
}

function stackPrefixMatches(
  current: ProfileStackEntry[],
  next: ProfileStackEntry[],
) {
  // The root is a valid prefix too. Dropping the last entry must retain its
  // exiting screen until settlement rather than unmounting it immediately.
  const sharedLength = Math.min(current.length, next.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (current[index]?.key !== next[index]?.key) {
      return false;
    }
  }
  return true;
}

export function ProfileStackNavigator({
  rootContent,
  entries,
  resetScroll = true,
}: {
  rootContent: ReactNode;
  entries: ProfileStackEntry[];
  resetScroll?: boolean;
}) {
  const [activeIndex, setActiveIndex] = useState(entries.length);
  const [renderedEntries, setRenderedEntries] = useState(entries);
  const pruneTimerRef = useRef<number | null>(null);
  const entryFrameRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const requestedEntriesRef = useRef(entries);
  const previousActiveKeyRef = useRef("root");
  const scrollPositionsRef = useRef<Record<string, number>>({});

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      if (entryFrameRef.current !== null) cancelAnimationFrame(entryFrameRef.current);
      if (pruneTimerRef.current !== null) {
        window.clearTimeout(pruneTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // Our own retained-screen update is not a new navigation request.
    if (screensMatch(requestedEntriesRef.current, entries)) return;
    requestedEntriesRef.current = entries;
    const generation = ++generationRef.current;
    if (entryFrameRef.current !== null) {
      cancelAnimationFrame(entryFrameRef.current);
      entryFrameRef.current = null;
    }
    const enter = (index: number) => {
      entryFrameRef.current = requestAnimationFrame(() => {
        entryFrameRef.current = null;
        if (generationRef.current === generation) setActiveIndex(index);
      });
    };
    if (pruneTimerRef.current !== null) {
      window.clearTimeout(pruneTimerRef.current);
      pruneTimerRef.current = null;
    }

    if (screensMatch(renderedEntries, entries)) {
      setActiveIndex(entries.length);
      return;
    }

    const currentLength = renderedEntries.length;
    const nextLength = entries.length;

    if (currentLength === 0 && nextLength > 0) {
      setRenderedEntries(entries);
      setActiveIndex(0);
      enter(nextLength);
      return;
    }

    if (
      stackPrefixMatches(renderedEntries, entries) &&
      nextLength > currentLength
    ) {
      setRenderedEntries(entries);
      setActiveIndex(currentLength);
      enter(nextLength);
      return;
    }

    if (
      stackPrefixMatches(renderedEntries, entries) &&
      nextLength < currentLength
    ) {
      setActiveIndex(nextLength);
      pruneTimerRef.current = window.setTimeout(() => {
        pruneTimerRef.current = null;
        if (generationRef.current === generation) setRenderedEntries(entries);
      }, STACK_TRANSITION_MS);
      return;
    }

    setRenderedEntries(entries);
    setActiveIndex(nextLength);
  }, [entries, renderedEntries]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    // A closing pane can remain in the DOM while a route-level Profile page
    // mounts. Select the root owned by this presentation instead of taking the
    // first Profile pane left by that exit transition.
    const scrollRoot = document.querySelector<HTMLElement>(
      resetScroll
        ? '[data-app-scroll-root="true"]'
        : '[data-profile-pane-scroll-root="true"]',
    );
    if (!scrollRoot) return;

    const activeKey =
      activeIndex === 0
        ? "root"
        : renderedEntries[activeIndex - 1]?.key || "root";
    const previousKey = previousActiveKeyRef.current;
    if (!resetScroll && previousKey !== activeKey) {
      scrollPositionsRef.current[previousKey] = scrollRoot.scrollTop;
    }

    const nextTop = resetScroll
      ? 0
      : scrollPositionsRef.current[activeKey] ?? 0;
    scrollRoot.scrollTo({ top: nextTop, behavior: "auto" });
    previousActiveKeyRef.current = activeKey;
  }, [activeIndex, renderedEntries, resetScroll]);

  const screens = [
    {
      key: "root",
      content: rootContent,
      title: null,
      description: undefined,
      isRoot: true,
    },
    ...renderedEntries.map((entry) => {
      const liveEntry = entries.find(
        (candidate) => candidate.key === entry.key,
      );
      return {
        ...(liveEntry || entry),
        isRoot: false,
      };
    }),
  ];

  /* Panes are stacked in a single grid cell instead of laid out as a 100%-wide
   * horizontal track inside a `100dvh` box.
   *
   * The old shape gave Profile its own viewport-height scroller nested inside
   * the document scroll, so the page rendered two scrollbars and stranded the
   * last rows ("Account access" → "Sign out") in a dead region under the
   * floating Talk to One bar. Here only the active pane is in flow, so the
   * stack is exactly as tall as the screen being shown and the document does
   * all the scrolling — the same model every other route (One Location
   * included) already uses. Inactive panes stay mounted so their state and
   * in-flight data survive a push/pop; they are transparent and out of flow,
   * so they cost no height and still slide. */
  return (
    <div
      className="relative w-full overflow-x-clip"
      data-profile-stack="true"
    >
      <div className="grid w-full grid-cols-1 [grid-template-areas:'stack']">
        {screens.map((entry, index) => {
          const offset = index - Math.max(activeIndex, 0);
          const isActive = offset === 0;
          return (
            <section
              key={entry.key}
              className={cn(
                "w-full min-w-0 [grid-area:stack] transition-[transform,opacity] duration-[150ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                isActive
                  ? "relative z-10 opacity-100"
                  : "pointer-events-none absolute inset-x-0 top-0 opacity-0",
              )}
              style={{ transform: `translateX(${offset * 100}%)` }}
              aria-hidden={isActive ? undefined : true}
              inert={!isActive}
              data-profile-stack-screen={entry.key}
              data-profile-stack-active={isActive ? "true" : undefined}
            >
              {entry.isRoot ? (
                entry.content
              ) : (
                <div
                  data-profile-stack-content="true"
                  /* A reading gap, not a reserve for the fixed bottom bars.
                   * This sits inside the scroll root, which already reserves
                   * them — see --app-page-content-bottom-gap. It used to carry
                   * --app-bottom-content-clearance, a second full copy of that
                   * band, on top of the one .app-page-shell was also adding. */
                  className="mx-auto flex w-full max-w-[720px] flex-col gap-[var(--page-header-section-gap)] pt-[var(--page-header-section-gap)]"
                >
                  <PageHeader
                    title={entry.title}
                    description={entry.description}
                    // The sheet header (pane) or the bar's crumb (route)
                    // already names this screen; drawn again it read
                    // "Your account" then "Account" one line apart.
                    titleVisuallyHidden
                    testId="profile-stack-page-header"
                  />
                  <SettingsPresentationProvider
                    separatorInset
                    density="compact"
                  >
                    {entry.content}
                  </SettingsPresentationProvider>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
