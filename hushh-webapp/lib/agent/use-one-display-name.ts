"use client";

import { useEffect } from "react";
import { usePkmDomainChangeRevision } from "@/lib/pkm/use-pkm-domain-change-revision";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { usePkmDomainResource } from "@/lib/pkm/pkm-domain-resource";
import { ownerStyleFromBranch } from "@/lib/agent/owner-style-settings";

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
