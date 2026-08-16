"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { SettingsPresentationProvider } from "@/components/app-ui/settings-ui";
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

function StackHeader({
  title,
  description,
}: {
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div
      className="mx-auto flex w-full max-w-[520px] flex-col gap-1 px-[var(--page-inline-gutter-standard)] pb-1 pt-3"
      data-profile-stack-header="true"
    >
      <h1 className="profile-home-name ui-text-identity-name text-[32px] font-bold tracking-tight text-[color:var(--ios-account-label)]">
        {title}
      </h1>
      {description ? (
        <p className="ui-text-page-subtitle text-[color:var(--ios-account-secondary-label)]">
          {description}
        </p>
      ) : null}
    </div>
  );
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

  useEffect(() => {
    // Detail content now flows into the app's own scroll root instead of a
    // nested scroll region of its own, so pushing a new screen must reset
    // that shared scroll position -- otherwise a detail screen mounts
    // already scrolled to wherever the previous screen left off.
    if (typeof document === "undefined") return;
    const scrollRoot = document.querySelector<HTMLElement>(
      '[data-app-scroll-root="true"]',
    );
    scrollRoot?.scrollTo({ top: 0 });
  }, [activeIndex]);

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

  return (
    <div
      className="relative w-full overflow-x-hidden flex flex-col flex-1 bg-[color:var(--ios-account-screen-background)]"
      data-profile-stack="true"
    >
      <div
        className="flex w-full items-start transition-transform duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ transform: `translateX(-${Math.max(activeIndex, 0) * 100}%)` }}
      >
        {/* No screen owns a scroll container of its own -- the page's single
            shared scroll root (data-app-scroll-root, in app/providers.tsx) is
            the only thing that ever scrolls. A screen not currently in view
            is still mounted here (so the horizontal slide has both ends to
            animate between) but is inert: it is only ever reached by tabbing
            or clicking through the active screen, never independently
            scrolled or focused. */}
        {screens.map((entry, index) => {
          const isActiveScreen = index === activeIndex;
          return (
            <section
              key={entry.key}
              className="flex min-w-full w-full shrink-0 flex-col"
              aria-hidden={isActiveScreen ? undefined : true}
              inert={!isActiveScreen}
              data-profile-stack-screen={entry.key}
            >
              {entry.isRoot ? (
                <div className="flex flex-1 flex-col">{entry.content}</div>
              ) : (
                <>
                  <StackHeader
                    title={entry.title}
                    description={entry.description}
                  />
                  <div
                    className="mx-auto flex w-full max-w-[520px] flex-1 flex-col gap-4 px-[var(--page-inline-gutter-standard)] pt-1"
                    data-profile-stack-content="true"
                  >
                    <SettingsPresentationProvider
                      separatorInset
                      density="compact"
                    >
                      {entry.content}
                    </SettingsPresentationProvider>
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
