"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { prefersReducedMotion } from "@/lib/morphy-ux/gsap";
import { cn } from "@/lib/utils";

const STACK_TRANSITION_MS = 260;

export type ProfileStackEntry = {
  key: string;
  title: ReactNode;
  description?: ReactNode;
  breadcrumb: ReactNode[];
  content: ReactNode;
};

function breadcrumbsEqual(left: ReactNode[], right: ReactNode[]) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => String(item) === String(right[index]));
}

function screensMatch(left: ProfileStackEntry[], right: ProfileStackEntry[]) {
  if (left.length !== right.length) return false;
  return left.every((screen, index) => {
    const candidate = right[index];
    if (!candidate) return false;
    return (
      screen.key === candidate.key &&
      String(screen.title) === String(candidate.title) &&
      String(screen.description || "") === String(candidate.description || "") &&
      breadcrumbsEqual(screen.breadcrumb, candidate.breadcrumb)
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
  breadcrumb,
}: {
  title: ReactNode;
  description?: ReactNode;
  breadcrumb: ReactNode[];
}) {
  return (
    <div className="mx-auto flex w-full max-w-[54rem] items-start px-4 pb-2 pt-3 sm:px-6 sm:pb-3 sm:pt-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Breadcrumb>
            <BreadcrumbList className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              {breadcrumb.map((item, index) => (
                <div key={`${String(item)}-${index}`} className="contents">
                  {index > 0 ? <BreadcrumbSeparator className="text-current/60" /> : null}
                  <BreadcrumbItem>
                    <BreadcrumbPage className="max-w-full truncate text-current">
                      {item}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </div>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="space-y-0.5">
            <div className="text-base font-semibold tracking-tight text-foreground sm:text-[1.05rem]">
              {title}
            </div>
            {description ? (
              <div className="text-sm leading-5 text-muted-foreground">{description}</div>
            ) : null}
          </div>
        </div>
      </div>
  );
}

export function ProfileStackNavigator({
  entries,
}: {
  entries: ProfileStackEntry[];
}) {
  const reducedMotion = typeof window !== "undefined" ? prefersReducedMotion() : false;
  const [visible, setVisible] = useState(entries.length > 0);
  const [entered, setEntered] = useState(entries.length > 0);
  const [renderedEntries, setRenderedEntries] = useState(entries);
  const [activeIndex, setActiveIndex] = useState(Math.max(0, entries.length - 1));
  const hideTimerRef = useRef<number | null>(null);
  const pruneTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
      if (pruneTimerRef.current !== null) {
        window.clearTimeout(pruneTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (pruneTimerRef.current !== null) {
      window.clearTimeout(pruneTimerRef.current);
      pruneTimerRef.current = null;
    }

    if (entries.length === 0) {
      if (!visible) return;
      if (reducedMotion) {
        setEntered(false);
        setVisible(false);
        setRenderedEntries([]);
        setActiveIndex(0);
        return;
      }
      setEntered(false);
      hideTimerRef.current = window.setTimeout(() => {
        setVisible(false);
        setRenderedEntries([]);
        setActiveIndex(0);
      }, STACK_TRANSITION_MS);
      return;
    }

    if (!visible) {
      setRenderedEntries(entries);
      setActiveIndex(Math.max(0, entries.length - 1));
      setVisible(true);
      setEntered(false);
      if (reducedMotion) {
        setEntered(true);
        return;
      }
      requestAnimationFrame(() => setEntered(true));
      return;
    }

    if (screensMatch(renderedEntries, entries)) {
      return;
    }

    const currentLength = renderedEntries.length;
    const nextLength = entries.length;

    if (!reducedMotion && stackPrefixMatches(renderedEntries, entries) && nextLength > currentLength) {
      setRenderedEntries(entries);
      setActiveIndex(Math.max(0, currentLength - 1));
      requestAnimationFrame(() => setActiveIndex(nextLength - 1));
      return;
    }

    if (!reducedMotion && stackPrefixMatches(renderedEntries, entries) && nextLength < currentLength) {
      setActiveIndex(nextLength - 1);
      pruneTimerRef.current = window.setTimeout(() => {
        setRenderedEntries(entries);
      }, STACK_TRANSITION_MS);
      return;
    }

    setRenderedEntries(entries);
    setActiveIndex(nextLength - 1);
  }, [entries, reducedMotion, renderedEntries, visible]);

  useEffect(() => {
    if (!visible || typeof document === "undefined") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [visible]);

  if (!visible) {
    return null;
  }

  return (
    <div
      className={cn(
        "absolute inset-0 z-40 overflow-hidden bg-background transition-transform duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        entered ? "translate-x-0" : "translate-x-full"
      )}
      data-profile-stack="true"
    >
      <div className="flex h-full w-full min-h-[calc(100dvh-var(--top-shell-reserved-height,0px))] bg-background transition-transform duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ transform: `translateX(-${Math.max(activeIndex, 0) * 100}%)` }}
      >
        {renderedEntries.map((entry) => (
          <section
            key={entry.key}
            className="flex min-h-full min-w-full w-full flex-col bg-background"
          >
            <StackHeader
              title={entry.title}
              description={entry.description}
              breadcrumb={entry.breadcrumb}
            />
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto flex w-full max-w-[54rem] flex-col gap-4 px-4 pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-4 sm:px-6 sm:pb-10 sm:pt-5">
                {entry.content}
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
