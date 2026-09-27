"use client";

import { useEffect, useRef } from "react";

import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

export const OUTGOING_REQUEST_WATCH_INTERVAL_MS = 5_000;

/**
 * Notice a sent connection request being resolved while its list is on screen.
 *
 * The push (`connection_request_resolved`) is the primary signal. Native iOS
 * has no SSE fallback, so a missing, denied, or delayed push used to leave an
 * accepted person out of "My connections" until a manual refresh. This watch
 * reads only the caller's pending request ids, and only while one is pending
 * and the app is visibly active; any change hands off to `onChanged`, which
 * owns the authoritative reconciliation.
 */
export function useOutgoingRequestResolutionWatch({
  pendingRequestIds,
  readPendingRequestIds,
  onChanged,
  intervalMs = OUTGOING_REQUEST_WATCH_INTERVAL_MS,
}: {
  pendingRequestIds: readonly string[];
  /** Resolves the server's pending ids, or null when the read failed. */
  readPendingRequestIds: (() => Promise<readonly string[] | null>) | null;
  onChanged: () => void;
  intervalMs?: number;
}): void {
  const pendingKey = [...new Set(pendingRequestIds.filter(Boolean))]
    .sort()
    .join("\n");
  const readRef = useRef(readPendingRequestIds);
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    readRef.current = readPendingRequestIds;
    onChangedRef.current = onChanged;
  });
  const canRead = readPendingRequestIds !== null;

  useEffect(() => {
    if (!pendingKey || !canRead || typeof document === "undefined") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let expected = new Set(pendingKey.split("\n"));

    const isVisiblyActive = () =>
      document.visibilityState !== "hidden" &&
      appInteractionCoordinator.getLifecycleSnapshot().state === "active";

    const schedule = () => {
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };

    const tick = async () => {
      timer = null;
      const read = readRef.current;
      if (cancelled || !read) return;
      if (!isVisiblyActive()) {
        schedule();
        return;
      }
      const result = await read().catch(() => null);
      if (cancelled) return;
      const current = result ? new Set(result.filter(Boolean)) : null;
      if (
        current &&
        (current.size !== expected.size ||
          [...current].some((requestId) => !expected.has(requestId)))
      ) {
        // Fire once per observed difference. The caller's reconciliation
        // normally replaces pendingRequestIds, which restarts this watch.
        expected = current;
        onChangedRef.current();
        if (current.size === 0) return;
      }
      schedule();
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [canRead, intervalMs, pendingKey]);
}
