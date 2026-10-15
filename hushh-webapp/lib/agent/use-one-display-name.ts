"use client";

import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { useEffect, useState } from "react";
import { ownerStyleFromBranch } from "@/lib/agent/owner-style-settings";
import { PkmDomainResourceService, usePkmDomainResource } from "@/lib/pkm/pkm-domain-resource";
import { usePkmDomainChangeRevision } from "@/lib/pkm/use-pkm-domain-change-revision";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

/** A chat read model of the existing encrypted identity branch, never a writer. */
export function useChatPreferredName(input: {
  userId: string | undefined;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  isVaultUnlocked: boolean;
}) {
  const { userId, vaultKey, vaultOwnerToken, isVaultUnlocked } = input;
  const enabled = Boolean(userId && vaultKey && vaultOwnerToken && isVaultUnlocked);
  const revision = usePkmDomainChangeRevision(userId, "identity");
  const [read, setRead] = useState<{
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    revision: number;
    name: string;
  } | null>(null);
  const current = enabled && read && read.userId === userId && read.vaultKey === vaultKey &&
    read.vaultOwnerToken === vaultOwnerToken ? read : null;
  const cached = enabled && userId
    ? PkmDomainResourceService.peek({ userId, domain: "identity" })?.data
    : null;
  const cachedName = cached?.key.userId === userId
    ? ownerStyleFromBranch(cached?.data.communication_preferences).preferred_name ?? ""
    : "";

  useEffect(() => {
    if (!enabled || !userId || !vaultKey || !vaultOwnerToken) {
      setRead(null);
      return;
    }
    let active = true;
    const epoch = snapshotVaultSessionEpoch();
    const cachedIdentity = PkmDomainResourceService.peek({ userId, domain: "identity" })?.data;
    const hasCachedName = cachedIdentity?.key.userId === userId &&
      Boolean(ownerStyleFromBranch(cachedIdentity.data.communication_preferences).preferred_name);
    void PkmDomainResourceService.getStaleFirst({
      userId, domain: "identity", vaultKey, vaultOwnerToken,
      forceRefresh: revision > 0 || !hasCachedName,
    }).then((snapshot) => {
      if (!active || !isVaultSessionEpochCurrent(epoch) ||
        (snapshot && snapshot.key.userId !== userId)) return;
      setRead({
        userId, vaultKey, vaultOwnerToken, revision,
        name: ownerStyleFromBranch(snapshot?.data.communication_preferences).preferred_name ?? "",
      });
    }).catch(() => {
      // A failed/invalidated read is unknown, never permission to ask again.
      if (active) setRead((previous) => previous ? { ...previous, revision: -1 } : null);
    });
    return () => { active = false; };
  }, [enabled, userId, vaultKey, vaultOwnerToken, revision]);

  return {
    preferredName: enabled ? current?.name ?? cachedName : "",
    ready: Boolean(current && current.revision === revision),
  };
}


/** Never display another owner's snapshot or information from a locked vault. */
export function useOneDisplayName(enabled = true): string {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const canRead = Boolean(enabled && user?.uid && isVaultUnlocked && vaultKey && vaultOwnerToken);
  const revision = usePkmDomainChangeRevision(user?.uid, "identity");
  const identity = usePkmDomainResource({
    userId: user?.uid ?? "",
    domain: "identity",
    vaultKey,
    vaultOwnerToken,
    enabled: canRead,
  });
  const { refresh } = identity;
  useEffect(() => {
    if (canRead && revision > 0) void refresh({ force: true });
  }, [canRead, revision, refresh]);
  if (!canRead || identity.data?.key.userId !== user?.uid) return "One";
  return ownerStyleFromBranch(identity.data?.data.communication_preferences).preferred_name || "One";
}
