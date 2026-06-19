"use client";

import { useCallback, useState } from "react";

import { copyToClipboard } from "@/lib/utils/clipboard";

export function useClipboard() {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async (value: string) => {
    const didCopy = await copyToClipboard(value);
    setCopied(didCopy);
    return didCopy;
  }, []);

  const reset = useCallback(() => {
    setCopied(false);
  }, []);

  return { copied, copy, reset };
}
