"use client";

import { useEffect, useState } from "react";

import { currentPkmInvalidationEpoch } from "@/lib/cache/pkm-invalidation-epoch";

/**
 * Advances when the current owner's encrypted PKM changes. CacheSyncService
 * emits only owner, domain, revision, and timestamp metadata, so viewports can
 * re-read their own protected resources without receiving decrypted content in
 * the event channel. A non-zero value on first render means a write happened
 * before this screen mounted (see pkm-invalidation-epoch.ts).
 */
export function usePkmDomainChangeRevision(
  userId: string | null | undefined,
): number {
  // Seeded from the epoch so a screen that mounts after a write made elsewhere
  // starts above zero and forces a fresh read; the listener covers writes made
  // while it is mounted.
  const [revision, setRevision] = useState(() => currentPkmInvalidationEpoch(userId));

  useEffect(() => {
    if (!userId || typeof window === "undefined") return;
    setRevision((current) => Math.max(current, currentPkmInvalidationEpoch(userId)));

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
