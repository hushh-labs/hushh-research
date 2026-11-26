"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";

const SessionWatch = dynamic(
  () => import("@/components/gmail/mail-followups-session-watch")
    .then((module) => module.MailFollowupsSessionWatch),
  { ssr: false },
);

/** Keep opted-in watches active across navigation for the owner's unlocked session. */
export function MailFollowupsVaultBridge() {
  const { userId, loading, isAuthenticated, sessionVerificationRequired } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken, vaultKey, ownerTokenStatus } = useVault();
  const session = useMemo(() => {
    if (loading || !isAuthenticated || sessionVerificationRequired || !userId) return null;
    if (!isVaultUnlocked || ownerTokenStatus !== "valid" || !vaultKey || !vaultOwnerToken) return null;
    return { userId, vaultKey, vaultOwnerToken };
  }, [loading, isAuthenticated, sessionVerificationRequired, userId,
    isVaultUnlocked, ownerTokenStatus, vaultKey, vaultOwnerToken]);

  return session ? <SessionWatch session={session} /> : null;
}
