"use client";

import { useCallback, useEffect, useRef } from "react";

type SmartPrefetchOptions = {
  enabled?: boolean;
  rootMargin?: string;
  threshold?: number;
  onPrefetch: () => void | Promise<void>;
};

export function useSmartPrefetch<TElement extends HTMLElement>({
  enabled = true,
  rootMargin = "200px",
  threshold = 0,
  onPrefetch,
}: SmartPrefetchOptions) {
  const elementRef = useRef<TElement | null>(null);
  const prefetchedRef = useRef(false);

  const setPrefetchElement = useCallback((element: TElement | null) => {
    elementRef.current = element;
  }, []);

  useEffect(() => {
    const element = elementRef.current;

    if (!enabled || !element || prefetchedRef.current) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || prefetchedRef.current) {
          return;
        }

        prefetchedRef.current = true;
        void onPrefetch();
        observer.disconnect();
      },
      {
        rootMargin,
        threshold,
      }
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [enabled, onPrefetch, rootMargin, threshold]);

  return {
    setPrefetchElement,
    
  };
}