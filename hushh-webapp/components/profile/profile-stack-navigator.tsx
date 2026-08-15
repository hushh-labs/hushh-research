"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { SettingsPresentationProvider } from "@/components/app-ui/settings-ui";
import { PageHeader } from "@/components/app-ui/page-sections";
import { cn } from "@/lib/utils";

const STACK_TRANSITION_MS = 260;

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
  if (current.length === 0 || next.length === 0) return false;
  const sharedLength = Math.min(current.length, next.length) - 1;
  if (sharedLength <= 0) return true;
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
}: {
  rootContent: ReactNode;
  entries: ProfileStackEntry[];
}) {
  const [activeIndex, setActiveIndex] = useState(entries.length);
  const [renderedEntries, setRenderedEntries] = useState(entries);
  const pruneTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pruneTimerRef.current !== null) {
        window.clearTimeout(pruneTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
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
      requestAnimationFrame(() => setActiveIndex(nextLength));
      return;
    }

    if (
      stackPrefixMatches(renderedEntries, entries) &&
      nextLength > currentLength
    ) {
      setRenderedEntries(entries);
      setActiveIndex(currentLength);
      requestAnimationFrame(() => setActiveIndex(nextLength));
      return;
    }

    if (
      stackPrefixMatches(renderedEntries, entries) &&
      nextLength < currentLength
    ) {
      setActiveIndex(nextLength);
      pruneTimerRef.current = window.setTimeout(() => {
        setRenderedEntries(entries);
      }, STACK_TRANSITION_MS);
      return;
    }

    setRenderedEntries(entries);
    setActiveIndex(nextLength);
  }, [entries, renderedEntries]);

  /* Pushing a screen starts the reader at its header rather than wherever the
   * previous screen was scrolled to. The stack no longer owns a scroll
   * container (see below), so this scrolls the document — the same thing a
   * route change does everywhere else in the app. */
  useEffect(() => {
    if (activeIndex <= 0) return;
    if (typeof window === "undefined") return;
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, renderedEntries]);

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
                "w-full min-w-0 [grid-area:stack] transition-[transform,opacity] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                isActive
                  ? "relative z-10 opacity-100"
                  : "pointer-events-none absolute inset-x-0 top-0 opacity-0",
              )}
              style={{ transform: `translateX(${offset * 100}%)` }}
              aria-hidden={isActive ? undefined : true}
              data-profile-stack-screen={entry.key}
              data-profile-stack-active={isActive ? "true" : undefined}
            >
              {entry.isRoot ? (
                entry.content
              ) : (
                <div
                  data-profile-stack-content="true"
                  /* pb reserves room for BOTH fixed bottom bars (nav + the
                   * floating Talk to One bar) via the runtime-measured
                   * clearance token. Only the account screen used to get this,
                   * so every other pushed screen ended with its last row
                   * underneath the agent bar. */
                  className="mx-auto flex w-full max-w-[720px] flex-col gap-[var(--page-header-section-gap)] px-[var(--page-inline-gutter-standard)] pb-[var(--app-bottom-content-clearance)] pt-[var(--page-header-section-gap)]"
                >
                  <PageHeader
                    title={entry.title}
                    description={entry.description}
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
