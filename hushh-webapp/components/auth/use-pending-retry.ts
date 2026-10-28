"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** "Checking…" lasts exactly as long as the caller's retry; a void retry settles at once.
 * The AuthProvider still coalesces retries, so this is feedback, not the only guard. */
export function usePendingRetry(onRetry: () => void | Promise<unknown>): [boolean, () => void] {
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const retry = useCallback(() => {
    setPending(true);
    const settle = () => { if (mounted.current) setPending(false); };
    // A synchronous throw settles too; validation itself runs under its own deadline.
    void new Promise<unknown>(resolve => resolve(onRetry())).then(settle, settle);
  }, [onRetry]);
  return [pending, retry];
}
