"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  contactInvitationsEnabled,
  type InviteCandidate,
} from "./invitation-candidates";
import {
  assertInvitationShare,
  type InvitationShare,
} from "@/lib/services/contact-invitations-service";
import { personalizeInvitation } from "./personalize-invitation";

/** Owned by the sync surface, never a global store or persisted query. */
export function useContactInvitations(userId: string | null | undefined) {
  const enabled = contactInvitationsEnabled();
  const owner = userId ?? null;
  const ownerRef = useRef(owner);
  const generation = useRef(0);
  const prepareRef = useRef<(() => Promise<InvitationShare | null>) | null>(
    null,
  );
  const pendingPreparation = useRef<object | null>(null);
  const [candidates, setCandidates] = useState<InviteCandidate[]>([]);
  const [active, setActive] = useState(false);
  const [share, setShare] = useState<InvitationShare | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const clear = useCallback(() => {
    generation.current += 1;
    prepareRef.current = null;
    pendingPreparation.current = null;
    setVersion(generation.current);
    setCandidates([]);
    setActive(false);
    setShare(null);
    setPreparing(false);
    setError(null);
  }, []);

  useLayoutEffect(() => {
    ownerRef.current = owner;
    clear();
    return () => {
      generation.current += 1;
    };
  }, [owner, enabled, clear]);

  const beginSync = useCallback(() => {
    clear();
    if (!enabled || !ownerRef.current) return undefined;
    const token = generation.current;
    const initiatingOwner = ownerRef.current;
    return (next: InviteCandidate[]) => {
      if (generation.current === token && ownerRef.current === initiatingOwner)
        setCandidates(next);
    };
  }, [clear, enabled]);

  const captureSession = useCallback(() => {
    const token = generation.current;
    const initiatingOwner = ownerRef.current;
    return () =>
      Boolean(initiatingOwner) &&
      generation.current === token &&
      ownerRef.current === initiatingOwner;
  }, []);

  const open = useCallback(
    async (prepare: () => Promise<InvitationShare | null>) => {
      if (!enabled || !ownerRef.current || !candidates.length) return false;
      if (pendingPreparation.current) return true;
      const token = generation.current;
      const request = {};
      pendingPreparation.current = request;
      prepareRef.current = prepare;
      setActive(true);
      setPreparing(true);
      setShare(null);
      setError(null);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const prepared = await Promise.race([
          prepare(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Preparation timed out")),
              15_000,
            );
          }),
        ]);
        if (generation.current !== token) return false;
        if (prepared) {
          assertInvitationShare(prepared);
          for (const candidate of candidates) {
            assertInvitationShare(
              personalizeInvitation(prepared, candidate.displayName),
            );
          }
        }
        setShare(prepared);
        if (!prepared)
          setError(
            "An invitation link is unavailable. Retry to prepare it again.",
          );
      } catch {
        if (generation.current === token)
          setError(
            "Could not prepare the invitation. Check your connection and retry.",
          );
      } finally {
        clearTimeout(timeout);
        if (pendingPreparation.current === request)
          pendingPreparation.current = null;
        if (generation.current === token) setPreparing(false);
      }
      return generation.current === token;
    },
    [enabled, candidates],
  );

  const retryPreparation = useCallback(async () => {
    if (prepareRef.current) await open(prepareRef.current);
  }, [open]);

  const currentOwner = ownerRef.current === owner;
  return {
    enabled,
    version,
    clear,
    beginSync,
    open,
    retryPreparation,
    captureSession,
    candidates: currentOwner ? candidates : [],
    active: currentOwner && active,
    share: currentOwner ? share : null,
    preparing,
    error,
  };
}

export type ContactInvitationController = ReturnType<
  typeof useContactInvitations
>;
