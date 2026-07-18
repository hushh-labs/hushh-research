"use client";

import { useEffect, useRef } from "react";

export function usePrevious<T>(value: T): T | undefined {
  const previousRef = useRef<T | undefined>(undefined);

  useEffect(() => {
    previousRef.current = value;
  }, [value]);

  // `usePrevious` intentionally exposes the ref value captured before this render.
  // eslint-disable-next-line react-hooks/refs
  return previousRef.current;
}
