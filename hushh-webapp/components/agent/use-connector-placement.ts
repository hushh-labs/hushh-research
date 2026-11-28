"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { useOwnerPresentationState } from "@/hooks/use-owner-presentation-state";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { ownerRequiresByocIsolation } from "@/lib/one/byoc-isolation";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

const MAX_SETTLED_PLACEMENTS = 8;
const settledPlacements = new Map<string, "shared" | "private">();

function placementCacheKey(
  firebaseUid: string | null,
  ownerId: string | null,
  generation: number | undefined,
  epoch: number,
): string | null {
  if (!firebaseUid || !ownerId || generation === undefined) return null;
  return `${firebaseUid}:${ownerId}:${generation}:${epoch}`;
}

export function rememberConnectorPlacement(
  firebaseUid: string | null,
  ownerId: string | null,
  value: "shared" | "private",
): void {
  const principal = snapshotValidatedAuthSessionPrincipal();
  if (!principal || principal.firebaseUid !== firebaseUid || principal.ownerId !== ownerId) return;
  const key = placementCacheKey(firebaseUid, ownerId, principal.generation, snapshotVaultSessionEpoch());
  if (!key) return;
  if (!settledPlacements.has(key) && settledPlacements.size >= MAX_SETTLED_PLACEMENTS) {
    const oldest = settledPlacements.keys().next().value;
    if (oldest !== undefined) settledPlacements.delete(oldest);
  }
  settledPlacements.set(key, value);
}

class ConnectorPlacementVisit {
  live = false;
  pending = false;
  constructor(readonly open: boolean, readonly firebaseUid: string | null, readonly ownerId: string | null,
    readonly generation: number | undefined, readonly epoch: number) {}
}

/** One hosting reader for both renderers. Retry cannot publish into a retired
 * owner, vault or reopened connector visit. No credential replica is retained. */
export function useConnectorPlacement(open: boolean, firebaseUid: string | null, ownerId: string | null) {
  const principal = snapshotValidatedAuthSessionPrincipal();
  const generation = principal?.generation;
  const epoch = snapshotVaultSessionEpoch();
  const cacheKey = placementCacheKey(firebaseUid, ownerId, generation, epoch);
  const warmPlacement = useMemo(
    () => (cacheKey ? settledPlacements.get(cacheKey) ?? null : null),
    [cacheKey],
  );
  // Settled renderer identity survives ordinary renewal and close/reopen.
  // Request eligibility has a shorter lifetime and cannot publish after either.
  const identity = useMemo(() => ({ live: false, firebaseUid, ownerId }), [firebaseUid, ownerId]);
  useLayoutEffect(() => { identity.live = true; return () => { identity.live = false; }; }, [identity]);
  const visit = useMemo(() => new ConnectorPlacementVisit(open, firebaseUid, ownerId, generation, epoch),
    [open, firebaseUid, ownerId, generation, epoch]);
  useLayoutEffect(() => { visit.live = open; return () => { visit.live = false; }; }, [visit, open]);
  const [placement, setPlacement] = useOwnerPresentationState<"shared" | "private" | "unavailable" | null>(
    identity,
    warmPlacement,
  );
  const refresh = useCallback(async () => {
    const owner = snapshotValidatedAuthSessionPrincipal();
    const current = () => visit.live && !!owner && owner.firebaseUid === firebaseUid && owner.ownerId === ownerId &&
      owner.generation === visit.generation && isValidatedAuthSessionOwnerCurrent(owner) && snapshotVaultSessionEpoch() === epoch;
    if (!current() || visit.pending) return false;
    visit.pending = true;
    setPlacement(value => value === "shared" || value === "private" ? value : null);
    try {
      const privateAgent = await ownerRequiresByocIsolation();
      if (!current()) return false;
      const next = privateAgent ? "private" : "shared";
      rememberConnectorPlacement(firebaseUid, ownerId, next);
      setPlacement(next);
      return true;
    } catch {
      if (current()) setPlacement("unavailable");
      return false;
    } finally { visit.pending = false; }
  }, [visit, firebaseUid, ownerId, epoch, setPlacement]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { placement, refresh };
}
