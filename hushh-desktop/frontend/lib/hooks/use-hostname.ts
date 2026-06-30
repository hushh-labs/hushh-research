"use client";

import { useEffect, useState } from "react";

/**
 * Safely retrieves the window.location.hostname without causing React hydration mismatches.
 * Returns null during SSR and on the first client render, then updates to the real hostname.
 */
export function useHostname() {
  const [hostname, setHostname] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setHostname(window.location.hostname);
    }
  }, []);

  return hostname;
}
