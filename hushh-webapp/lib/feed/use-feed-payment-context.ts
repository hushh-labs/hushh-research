"use client";

import { useEffect, useRef, useState } from "react";
import { DriveSharingService, type SharingRequestContext } from "@/lib/services/drive-sharing-service";

const EMPTY_CONTEXTS: Readonly<Record<string, SharingRequestContext>> = {};

/** Private request text stays in this mount, never the Feed/Consent cache. */
export function useFeedPaymentContext(
  userId: string | null,
  vaultOwnerToken: string | null,
  requestIds: string[],
): Readonly<Record<string, SharingRequestContext>> {
  const requestKey = [...new Set(requestIds)].sort().join("|");
  const session = useRef({ userId, vaultOwnerToken, requestKey });
  session.current = { userId, vaultOwnerToken, requestKey };
  const [snapshot, setSnapshot] = useState<{
    userId: string;
    token: string;
    contexts: Record<string, SharingRequestContext>;
  } | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    if (!userId || !vaultOwnerToken || !requestKey) {
      setSnapshot(null);
      return;
    }
    let active = true;
    const guard = () => {
      if (!active || session.current.userId !== userId ||
          session.current.vaultOwnerToken !== vaultOwnerToken ||
          session.current.requestKey !== requestKey) {
        throw new Error("Request context changed");
      }
    };
    const visibleIds = requestKey.split("|");
    setSnapshot((current) => current?.userId === userId && current.token === vaultOwnerToken
      ? { ...current, contexts: Object.fromEntries(Object.entries(current.contexts)
        .filter(([requestId]) => visibleIds.includes(requestId))) }
      : null);
    const previous = snapshotRef.current;
    const known = previous?.userId === userId && previous.token === vaultOwnerToken
      ? previous.contexts : EMPTY_CONTEXTS;
    const ids = visibleIds.filter((requestId) => !known[requestId]);
    let next = 0;
    const load = async () => {
      while (active && next < ids.length) {
        const requestId = ids[next++]!;
        try {
          guard();
          const context = await DriveSharingService.requesterContext(vaultOwnerToken, requestId, guard);
          guard();
          setSnapshot((current) => ({
            userId,
            token: vaultOwnerToken,
            contexts: {
              ...(current?.userId === userId && current.token === vaultOwnerToken
                ? current.contexts : {}),
              [requestId]: context,
            },
          }));
        } catch {
          // One missing/erased request cannot hide other payments. The row
          // retains metadata-only copy; private/provider failures stay silent.
        }
      }
    };
    // At most two private reads at once, only for the visible payment rows.
    void Promise.allSettled([load(), load()]);
    return () => { active = false; };
  }, [userId, vaultOwnerToken, requestKey]);

  // Drop context synchronously on lock/account change, before effect cleanup.
  if (!userId || !vaultOwnerToken || snapshot?.userId !== userId || snapshot.token !== vaultOwnerToken)
    return EMPTY_CONTEXTS;
  return snapshot.contexts;
}
