"use client";

import { useEffect, useState } from "react";

// The first hydrated render intentionally remains unknown so server and client
// agree. Once the host is observed, retain this non-sensitive browser fact for
// the document lifetime; route-local guards then avoid a null-host loader on
// every client navigation.
let observedClientHostname: string | null = null;

/**
 * Safely retrieves the window.location.hostname without causing React hydration mismatches.
 * Returns null during SSR and on the first client render, then updates to the real hostname.
 * Later route mounts reuse the observed hostname synchronously.
 */
export function useHostname() {
  const [hostname, setHostname] = useState<string | null>(() =>
    typeof window === "undefined" ? null : observedClientHostname,
  );

  useEffect(() => {
    if (typeof window !== "undefined") {
      const nextHostname = window.location.hostname;
      observedClientHostname = nextHostname;
      setHostname((current) =>
        current === nextHostname ? current : nextHostname,
      );
    }
  }, []);

  return hostname;
}
