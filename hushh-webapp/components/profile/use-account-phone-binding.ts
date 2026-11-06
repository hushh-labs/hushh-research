"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionPrincipal,
  type AuthSessionOwnerSnapshot,
} from "@/lib/auth/session-owner";
import type { useAuth } from "@/lib/firebase/auth-context";
import { AuthService } from "@/lib/services/auth-service";

type ProviderPhoneRead = {
  owner: AuthSessionOwnerSnapshot;
} & (
  | { status: "loading" | "unavailable" }
  | { status: "ready"; phoneNumber: string | null }
);

type FirebasePhoneUser = { uid: string; phoneNumber: string | null };
export type AccountPhoneBindingStatus = "verified" | "needs-verification" | "missing" | "loading" | "unavailable";

export function useAccountPhoneBinding({
  active,
  ownerId,
  firebaseUid,
  appPhone,
  appStatus,
}: {
  active: boolean;
  ownerId: string | null;
  firebaseUid: string | undefined;
  appPhone: string | null;
  appStatus: ReturnType<typeof useAuth>["phoneNumberStatus"];
}) {
  const [read, setRead] = useState<ProviderPhoneRead | null>(null);
  const request = useRef(0);
  const currentOwner = useCallback(() => {
    const owner = snapshotValidatedAuthSessionPrincipal();
    return active && owner?.ownerId === ownerId && owner?.firebaseUid === firebaseUid ? owner : null;
  }, [active, ownerId, firebaseUid]);

  const refreshProviderPhone = useCallback(async () => {
    const owner = currentOwner();
    if (!owner) return null;
    const attempt = ++request.current;
    const isCurrent = () => attempt === request.current && isValidatedAuthSessionOwnerCurrent(owner);
    setRead({ owner, status: "loading" });
    try {
      const user = await AuthService.reloadPhoneVerificationUser(owner.firebaseUid);
      if (!isCurrent()) return null;
      if (user?.uid === owner.firebaseUid) {
        setRead({ owner, status: "ready", phoneNumber: user.phoneNumber });
        return user;
      }
    } catch {
      // A provider failure leaves the previous binding unconfirmed.
    }
    if (isCurrent()) setRead({ owner, status: "unavailable" });
    return null;
  }, [currentOwner]);

  useLayoutEffect(() => {
    void refreshProviderPhone();
    return () => { request.current += 1; };
  }, [refreshProviderPhone]);

  const acceptVerifiedUser = useCallback((user: FirebasePhoneUser) => {
    const owner = currentOwner();
    if (!owner || user.uid !== owner.firebaseUid) return;
    request.current += 1;
    setRead({ owner, status: "ready", phoneNumber: user.phoneNumber });
  }, [currentOwner]);

  const current = active && read?.owner.userId === ownerId &&
    isValidatedAuthSessionOwnerCurrent(read.owner) ? read : null;
  const providerPhone = current?.status === "ready" ? current.phoneNumber : null;
  const linkedPhone = current?.status === "ready" && appStatus === "verified" &&
    providerPhone === appPhone ? appPhone : null;
  const status: AccountPhoneBindingStatus = current?.status === "unavailable" || appStatus === "unavailable"
    ? "unavailable"
    : current?.status !== "ready" || (!appPhone && appStatus !== "missing")
      ? "loading"
      : linkedPhone
        ? "verified"
        : providerPhone || appPhone ? "needs-verification" : "missing";

  return { status, linkedPhone, providerPhone, refreshProviderPhone, acceptVerifiedUser };
}
