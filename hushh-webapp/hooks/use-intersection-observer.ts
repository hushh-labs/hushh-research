"use client";

import { useEffect, useState, type RefObject } from "react";

type UseIntersectionObserverOptions = IntersectionObserverInit & {
  disabled?: boolean;
};

export function useIntersectionObserver(
  targetRef: RefObject<Element | null>,
  options: UseIntersectionObserverOptions = {},
) {
  const { disabled = false, root = null, rootMargin, threshold } = options;
  const [entry, setEntry] = useState<IntersectionObserverEntry | null>(null);

  useEffect(() => {
    const target = targetRef.current;
    if (disabled || !target || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      ([nextEntry]) => {
        setEntry(nextEntry ?? null);
      },
      { root, rootMargin, threshold },
    );

    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, [disabled, root, rootMargin, targetRef, threshold]);

  return entry;
}
