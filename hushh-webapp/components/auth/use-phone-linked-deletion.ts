"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { apiErrorCode } from "@/lib/services/api-client";
import type { LinkedDeletionPreparation } from "@/lib/services/phone-recovery-service";
import { linkedDeletionMessage, linkedDeletionNeedsFreshProof, type LinkedDeletionInput } from "@/lib/auth/phone-linked-deletion";

type Conflict = "choices" | "review" | "delete" | null;
type Params = {
  phone: string; conflict: Conflict; busy: boolean; guard: { pending: boolean };
  current: () => boolean; entryIsCurrent: () => boolean; inFlight: { current: boolean };
  setBusy: (busy: boolean) => void; setConflict: (conflict: Conflict) => void; setError: (message: string | null) => void;
  prepare?: (phone: string) => Promise<LinkedDeletionPreparation>;
  cancel?: (operation: string) => Promise<unknown>;
  confirm?: (input: LinkedDeletionInput, isCurrent: () => boolean) => Promise<User>;
  /** The existing previous-account sign-in handoff, used when in-place deletion is off. */
  fallback: () => Promise<void>;
  onDeleted: (user: User) => Promise<void>;
};

/** In-place deletion of the account holding the number; the server decides every effect. */
export function usePhoneLinkedDeletion(p: Params) {
  const [reviewState, setReview] = useState<{ prepared: LinkedDeletionPreparation; entryIsCurrent: () => boolean } | null>(null);
  const liveReview = useRef<{ state: NonNullable<typeof reviewState>; readbackOnly: boolean; claimUnconfirmed: boolean } | null>(null);
  const prepared = reviewState?.prepared ?? null;
  const [freshProof, setFreshProof] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const { phone, conflict, busy, guard, current, entryIsCurrent, inFlight, setBusy, setConflict, setError, prepare, cancel, confirm, fallback, onDeleted } = p;
  useLayoutEffect(() => {
    liveReview.current = null; setReview(null); setFreshProof(false); setUnconfirmed(false);
    return () => { liveReview.current = null; };
  }, [guard]);

  const review = useCallback(async () => {
    if (!current() || !entryIsCurrent() || conflict !== "choices" || busy || inFlight.current || liveReview.current) return;
    if (!prepare || !confirm) return fallback();
    inFlight.current = true; setBusy(true); setError(null);
    let unavailable = false;
    try {
      const value = await prepare(phone);
      if (!current() || !entryIsCurrent()) return;
      const next = { prepared: value, entryIsCurrent };
      liveReview.current = { state: next, readbackOnly: false, claimUnconfirmed: false }; setReview(next); setFreshProof(false); setUnconfirmed(false); setConflict("delete");
    } catch (error) {
      if (!current() || !entryIsCurrent()) return;
      unavailable = apiErrorCode(error) === "PHONE_LINKED_DELETION_UNAVAILABLE";
      if (!unavailable) setError(linkedDeletionMessage(apiErrorCode(error)));
    } finally { inFlight.current = false; if (current()) setBusy(false); }
    if (unavailable && current() && entryIsCurrent()) await fallback();
  }, [busy, conflict, confirm, current, entryIsCurrent, fallback, inFlight, phone, prepare, setBusy, setConflict, setError]);

  const submit = useCallback(async (testCode?: string) => {
    if (!current() || conflict !== "delete" || !reviewState || !reviewState.entryIsCurrent() || liveReview.current?.state !== reviewState || liveReview.current.claimUnconfirmed || !confirm || busy || inFlight.current) return;
    const isCurrent = () => current() && reviewState.entryIsCurrent() && liveReview.current?.state === reviewState;
    inFlight.current = true; setBusy(true); setError(null); guard.pending = true;
    let committed = false;
    try {
      const user = await confirm({ operationId: reviewState.prepared.operation_id, phoneNumber: phone, testCode,
        ...(liveReview.current?.readbackOnly ? { readbackOnly: true } : {}) }, isCurrent);
      if (!isCurrent()) return;
      committed = true; guard.pending = false; liveReview.current = null; setReview(null);
      await onDeleted(user);
    } catch (error) {
      if (!isCurrent() || committed) return;
      const code = apiErrorCode(error);
      // Back is held only while a request is in flight: the server never
      // dispatches an operation twice, so leaving after a read-back is safe.
      guard.pending = false;
      if (code === "PHONE_LINKED_DELETION_SUPPORT_REQUIRED" && liveReview.current?.state === reviewState) liveReview.current.readbackOnly = true;
      if (code === "PHONE_LINKED_CLAIM_UNCONFIRMED" && liveReview.current?.state === reviewState) liveReview.current.claimUnconfirmed = true;
      setUnconfirmed(code === "PHONE_LINKED_DELETION_SUPPORT_REQUIRED");
      setFreshProof(linkedDeletionNeedsFreshProof(code));
      setError(linkedDeletionMessage(code));
    } finally { inFlight.current = false; if (liveReview.current?.state === reviewState) guard.pending = false; if (current()) setBusy(false); }
  }, [busy, confirm, conflict, current, guard, inFlight, onDeleted, phone, reviewState, setBusy, setError]);

  /** Leave the review; false only while a confirmation request is in flight. */
  const leave = useCallback(() => {
    if (guard.pending || (liveReview.current?.state ?? null) !== reviewState) return false;
    const operation = reviewState?.prepared.operation_id;
    liveReview.current = null; setReview(null); setFreshProof(false); setUnconfirmed(false);
    // Best effort: an expired or changed session must never break Back.
    if (operation && cancel) void Promise.resolve().then(() => cancel(operation)).catch(() => undefined);
    return true;
  }, [cancel, guard, reviewState]);

  return { prepared, freshProof, unconfirmed, review, submit, leave };
}
