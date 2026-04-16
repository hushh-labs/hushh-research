"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
const STACK_TRANSITION_MS = 260;

export type ProfileStackEntry = {
  key: string;
  title: ReactNode;
  description?: ReactNode;
  content: ReactNode;
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

function stackPrefixMatches(current: ProfileStackEntry[], next: ProfileStackEntry[]) {
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
    <div className="mx-auto flex w-full max-w-[54rem] items-start px-4 pb-2 pt-3 sm:px-6 sm:pb-3 sm:pt-4">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-base font-semibold tracking-tight text-foreground sm:text-[1.05rem]">
          {title}
        </div>
        {description ? (
          <div className="text-sm leading-5 text-muted-foreground">{description}</div>
        ) : null}
      </div>
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
  const scrollRegionRefs = useRef<Array<HTMLDivElement | null>>([]);

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

    if (stackPrefixMatches(renderedEntries, entries) && nextLength > currentLength) {
      setRenderedEntries(entries);
      setActiveIndex(currentLength);
      requestAnimationFrame(() => setActiveIndex(nextLength));
      return;
    }

    if (stackPrefixMatches(renderedEntries, entries) && nextLength < currentLength) {
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
    if (typeof document === "undefined") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = activeIndex > 0 ? "hidden" : previousOverflow;
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [activeIndex]);

  useEffect(() => {
    if (activeIndex <= 0) return;
    const frame = window.requestAnimationFrame(() => {
      scrollRegionRefs.current[activeIndex]?.scrollTo({ top: 0 });
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
      const liveEntry = entries.find((candidate) => candidate.key === entry.key);
      return {
        ...(liveEntry || entry),
        isRoot: false,
      };
    }),
  ];

  return (
    <div
      className="relative min-h-[calc(100dvh-var(--top-shell-reserved-height,0px))] overflow-hidden bg-background"
      data-profile-stack="true"
    >
      <div
        className="flex h-full w-full min-h-[calc(100dvh-var(--top-shell-reserved-height,0px))] bg-background transition-transform duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ transform: `translateX(-${Math.max(activeIndex, 0) * 100}%)` }}
      >
        {screens.map((entry, index) => (
          <section
            key={entry.key}
            className="flex min-h-full min-w-full w-full shrink-0 flex-col overflow-x-hidden bg-background"
          >
            {entry.isRoot ? (
              <div className="flex min-h-full flex-1 flex-col">{entry.content}</div>
            ) : (
              <>
                <StackHeader
                  title={entry.title}
                  description={entry.description}
                />
                <div
                  ref={(node) => {
                    scrollRegionRefs.current[index] = node;
                  }}
                  data-profile-stack-scroll="true"
                  className="flex-1 overflow-y-auto overflow-x-hidden"
                >
                  <div className="mx-auto flex w-full max-w-[54rem] flex-col gap-4 px-4 pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-4 sm:px-6 sm:pb-10 sm:pt-5">
                    {entry.content}
                  </div>
                </div>
              </>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
