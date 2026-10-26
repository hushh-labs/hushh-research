"use client";

import { useMemo } from "react";
import type { User } from "firebase/auth";
import { snapshotValidatedAuthSessionPrincipal, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { phoneRecoveryReviewRoute } from "@/lib/auth/phone-recovery-route";
import { PhoneRecoveryService, type PhoneRecoveryAction } from "@/lib/services/phone-recovery-service";
import { ROUTES } from "@/lib/navigation/routes";

type SignOut = (options: { redirectTo: string; expectedUserId?: string }) => Promise<void>;
export function phoneRecoveryHandoff(user: User | null | undefined, signOut: SignOut) {
  const begin = async (action: PhoneRecoveryAction, phone: string) => {
    const owner = snapshotValidatedAuthSessionPrincipal();
    const current = () => Boolean(user && owner && owner.firebaseUid === user.uid && isValidatedAuthSessionOwnerCurrent(owner));
    if (!user || !current()) throw new Error("Your account changed. Sign in again.");
    const result = await PhoneRecoveryService.create(user, action, phone, current);
    if (!current()) return;
    await signOut({ expectedUserId: owner!.ownerId,
      redirectTo: `${ROUTES.LOGIN}?redirect=${encodeURIComponent(phoneRecoveryReviewRoute(result.continuation_id))}` });
  };
  return { recoverPreviousAccount: (phone: string) => begin("recover", phone), deletePreviousAccount: (phone: string) => begin("delete", phone), revokePreviousAccountDevices: (phone: string) => begin("revoke", phone) };
}

export function usePhoneRecoveryHandoff(user: User | null | undefined, signOut: SignOut) {
  return useMemo(() => phoneRecoveryHandoff(user, signOut), [user, signOut]);
}

/** Bounded busy/error lifecycle; the phone model admits the current owner first. */
export async function performPhoneRecovery(callback: ((phone: string) => Promise<void> | void) | undefined,
  phone: string, current: () => boolean, inFlight: { current: boolean },
  setBusy: (busy: boolean) => void, setError: (message: string | null) => void) {
  if (!callback) return;
  inFlight.current = true; setBusy(true); setError(null);
  try { await callback(phone); }
  catch { if (current()) setError("Could not open account recovery. Please try again."); }
  finally { inFlight.current = false; if (current()) setBusy(false); }
}
