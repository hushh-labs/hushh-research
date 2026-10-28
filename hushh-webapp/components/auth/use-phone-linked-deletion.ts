"use client";

import { useCallback, useState } from "react";
import type { User } from "firebase/auth";
import { apiErrorCode } from "@/lib/services/api-client";
import type { LinkedDeletionPreparation } from "@/lib/services/phone-recovery-service";
import { linkedDeletionMessage, linkedDeletionNeedsFreshProof, type LinkedDeletionInput } from "@/lib/auth/phone-linked-deletion";

type Conflict = "choices" | "review" | "delete" | null;
type Params = {
  phone: string; conflict: Conflict; busy: boolean; guard: { pending: boolean };
  current: () => boolean; inFlight: { current: boolean };
  setBusy: (busy: boolean) => void; setConflict: (conflict: Conflict) => void; setError: (message: string | null) => void;
  prepare?: (phone: string) => Promise<LinkedDeletionPreparation>;
  cancel?: (operation: string) => Promise<unknown>;
  confirm?: (input: LinkedDeletionInput) => Promise<User>;
  /** The existing previous-account sign-in handoff, used when in-place deletion is off. */
  fallback: () => Promise<void>;
  onDeleted: (user: User) => Promise<void>;
};

/** In-place deletion of the account holding the number; the server decides every effect. */
export function usePhoneLinkedDeletion(p: Params) {
  const [prepared, setPrepared] = useState<LinkedDeletionPreparation | null>(null);
  const [freshProof, setFreshProof] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const { phone, conflict, busy, guard, current, inFlight, setBusy, setConflict, setError, prepare, cancel, confirm, fallback, onDeleted } = p;

  const review = useCallback(async () => {
    if (!current() || conflict !== "choices" || busy || inFlight.current) return;
    if (!prepare || !confirm) return fallback();
    inFlight.current = true; setBusy(true); setError(null);
    let unavailable = false;
    try {
      const value = await prepare(phone);
      if (!current()) return;
      setPrepared(value); setFreshProof(false); setUnconfirmed(false); setConflict("delete");
    } catch (error) {
      if (!current()) return;
      unavailable = apiErrorCode(error) === "PHONE_LINKED_DELETION_UNAVAILABLE";
      if (!unavailable) setError(linkedDeletionMessage(apiErrorCode(error)));
    } finally { inFlight.current = false; if (current()) setBusy(false); }
    if (unavailable && current()) await fallback();
  }, [busy, conflict, confirm, current, fallback, inFlight, phone, prepare, setBusy, setConflict, setError]);

  const submit = useCallback(async (testCode?: string) => {
    if (!current() || conflict !== "delete" || !prepared || !confirm || busy || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null); guard.pending = true;
    let committed = false;
    try {
      const user = await confirm({ operationId: prepared.operation_id, phoneNumber: phone, testCode });
      if (!current()) return;
      committed = true; guard.pending = false; setPrepared(null);
      await onDeleted(user);
    } catch (error) {
      if (!current() || committed) return;
      const code = apiErrorCode(error);
      // Back is held only while a request is in flight: the server never
      // dispatches an operation twice, so leaving after a read-back is safe.
      guard.pending = false;
      setUnconfirmed(code === "PHONE_LINKED_DELETION_SUPPORT_REQUIRED");
      setFreshProof(linkedDeletionNeedsFreshProof(code));
      setError(linkedDeletionMessage(code));
    } finally { inFlight.current = false; if (current()) setBusy(false); }
  }, [busy, confirm, conflict, current, guard, inFlight, onDeleted, phone, prepared, setBusy, setError]);

  /** Leave the review; false only while a confirmation request is in flight. */
  const leave = useCallback(() => {
    if (guard.pending) return false;
    const operation = prepared?.operation_id;
    setPrepared(null); setFreshProof(false); setUnconfirmed(false);
    // Best effort: an expired or changed session must never break Back.
    if (operation && cancel) void Promise.resolve().then(() => cancel(operation)).catch(() => undefined);
    return true;
  }, [cancel, guard, prepared]);

  return { prepared, freshProof, unconfirmed, review, submit, leave };
}
