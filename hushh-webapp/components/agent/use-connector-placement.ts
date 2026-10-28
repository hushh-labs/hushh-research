"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { useOwnerPresentationState } from "@/hooks/use-owner-presentation-state";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { ownerContentIsPrivate } from "@/lib/services/private-agent-specialist-chat";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

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
  // Settled renderer identity survives ordinary renewal and close/reopen.
  // Request eligibility has a shorter lifetime and cannot publish after either.
  const identity = useMemo(() => ({ live: false, firebaseUid, ownerId }), [firebaseUid, ownerId]);
  useLayoutEffect(() => { identity.live = true; return () => { identity.live = false; }; }, [identity]);
  const visit = useMemo(() => new ConnectorPlacementVisit(open, firebaseUid, ownerId, generation, epoch),
    [open, firebaseUid, ownerId, generation, epoch]);
  useLayoutEffect(() => { visit.live = open; return () => { visit.live = false; }; }, [visit, open]);
  const [placement, setPlacement] = useOwnerPresentationState<"shared" | "private" | "unavailable" | null>(identity, null);
  const refresh = useCallback(async () => {
    const owner = snapshotValidatedAuthSessionPrincipal();
    const current = () => visit.live && !!owner && owner.firebaseUid === firebaseUid && owner.ownerId === ownerId &&
      owner.generation === visit.generation && isValidatedAuthSessionOwnerCurrent(owner) && snapshotVaultSessionEpoch() === epoch;
    if (!current() || visit.pending) return false;
    visit.pending = true;
    setPlacement(value => value === "shared" || value === "private" ? value : null);
    try {
      const privateAgent = await ownerContentIsPrivate();
      if (!current()) return false;
      setPlacement(privateAgent ? "private" : "shared");
      return true;
    } catch {
      if (current()) setPlacement("unavailable");
      return false;
    } finally { visit.pending = false; }
  }, [visit, firebaseUid, ownerId, epoch, setPlacement]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { placement, refresh };
}
