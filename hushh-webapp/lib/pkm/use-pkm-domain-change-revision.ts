"use client";

import { useEffect, useState } from "react";

/**
 * Advances when the current owner's encrypted PKM changes. CacheSyncService
 * emits only owner, domain, revision, and timestamp metadata, so viewports can
 * re-read their own protected resources without receiving decrypted content in
 * the event channel.
 */
export function usePkmDomainChangeRevision(
  userId: string | null | undefined,
): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!userId || typeof window === "undefined") return;

    const handleChange = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: unknown }>).detail;
      if (detail?.userId !== userId) return;
      setRevision((current) => current + 1);
    };

    window.addEventListener("pkm-domain-changed", handleChange);
    return () => window.removeEventListener("pkm-domain-changed", handleChange);
  }, [userId]);

  return revision;
}
