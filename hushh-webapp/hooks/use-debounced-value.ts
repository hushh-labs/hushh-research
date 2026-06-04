"use client";

import * as React from "react";

/**
 * useDebouncedValue
 *
 * Returns a debounced copy of `value` that only updates after `delayMs`
 * milliseconds have passed without further changes. The classic "wait
 * until the user pauses typing before doing expensive work" primitive,
 * without forcing every search/filter surface to re-implement it.
 *
 * Common uses:
 *   - Debouncing a search input before firing the network request
 *   - Validating form fields after the user pauses typing
 *   - Filtering large lists without blocking input on each keystroke
 *   - Avoiding rapid-fire effect re-runs when a controlled value churns
 *
 * Semantics:
 *   - Returns the initial value on the first render (no waiting).
 *   - Every time `value` changes, a fresh `setTimeout` is scheduled and
 *     any pending one is cancelled, so a stream of keystrokes only
 *     commits the LAST value after the user stops typing.
 *   - Cleans up the pending timeout on unmount so no state update
 *     reaches an unmounted component.
 *   - Negative or non-finite delays are clamped to 0.
 *
 * @example
 *   const [query, setQuery] = useState("");
 *   const debouncedQuery = useDebouncedValue(query, 300);
 *   useEffect(() => {
 *     if (debouncedQuery) runSearch(debouncedQuery);
 *   }, [debouncedQuery]);
 *
 * @param value    The value to debounce.
 * @param delayMs  Milliseconds of silence before the debounced value updates.
 * @returns        The debounced copy of `value`.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState<T>(value);

  React.useEffect(() => {
    const clampedDelay =
      typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > 0
        ? delayMs
        : 0;

    const timer = window.setTimeout(() => {
      setDebounced(value);
    }, clampedDelay);

    return () => {
      window.clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debounced;
}