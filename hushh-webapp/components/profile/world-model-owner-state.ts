"use client";

import { useCallback, useLayoutEffect, useState, type SetStateAction } from "react";

/** Local private presentation only. The existing service/capture guard owns
 * authority. Hide old-owner values before paint and reject retired setters. */
export function useWorldModelOwnerState<T>(session: { live: boolean }, initial: T) {
  const [stored, setStored] = useState<{ session: object; value: T } | null>(null);
  const value = stored?.session === session ? stored.value : initial;
  const change = useCallback((update: SetStateAction<T>) => {
    if (!session.live) return;
    setStored(previous => {
      if (!session.live) return previous;
      const value = previous?.session === session ? previous.value : initial;
      const next = typeof update === "function" ? (update as (current: T) => T)(value) : update;
      if (Object.is(value, next)) return previous?.session === session ? previous : null;
      return { session, value: next };
    });
  }, [initial, session]);
  useLayoutEffect(() => { setStored(previous => previous?.session === session ? previous : null); }, [session]);
  return [value, change] as const;
}
