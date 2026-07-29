"use client";

import { useState, useCallback, useEffect } from "react";

interface UseCopyResult {
  isCopied: boolean;
  copy: (text: string) => Promise<void>;
  error: Error | null;
}

/**
 * A robust hook for copying text to the clipboard.
 * Manages the "copied" state with a configurable timeout.
 */
export function useCopy(timeoutMs: number = 2000): UseCopyResult {
  const [isCopied, setIsCopied] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const copy = useCallback(
    async (text: string) => {
      if (!navigator?.clipboard) {
        setError(new Error("Clipboard API not supported"));
        return;
      }

      try {
        await navigator.clipboard.writeText(text);
        setIsCopied(true);
        setError(null);
      } catch (err) {
        setIsCopied(false);
        setError(err instanceof Error ? err : new Error("Failed to copy text"));
      }
    },
    []
  );

  // Automatically reset the `isCopied` state after `timeoutMs`
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    if (isCopied) {
      timeout = setTimeout(() => {
        setIsCopied(false);
      }, timeoutMs);
    }
    return () => {
      if (timeout) clearTimeout(timeout);
    };
  }, [isCopied, timeoutMs]);

  return { isCopied, copy, error };
}
