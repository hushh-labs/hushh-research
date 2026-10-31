"use client";
import { useMemo, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import type { DocumentSession } from "@/lib/services/document-hosting-service";

export function useHostedDocumentSession(): DocumentSession | null {
  const { user, userId } = useAuth(); const { getVaultKey, getVaultOwnerToken, isVaultUnlocked } = useVault();
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  return useMemo(() => {
    const vaultKey = getVaultKey?.(), vaultOwnerToken = getVaultOwnerToken(), owner = snapshotValidatedAuthSessionOwner();
    if (!user || !userId || !isVaultUnlocked || !vaultKey || !vaultOwnerToken) return null;
    return { userId, vaultKey, vaultOwnerToken, isCurrent: () => isVaultSessionEpochCurrent(epoch) &&
      getVaultOwnerToken() === vaultOwnerToken && getVaultKey() === vaultKey && (!owner || isValidatedAuthSessionOwnerCurrent(owner)) };
  }, [user, userId, isVaultUnlocked, getVaultKey, getVaultOwnerToken, epoch]);
}
