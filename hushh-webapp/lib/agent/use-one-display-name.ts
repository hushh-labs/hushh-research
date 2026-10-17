"use client";

import { useEffect, useState } from "react";
import { usePkmDomainChangeRevision } from "@/lib/pkm/use-pkm-domain-change-revision";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { usePkmDomainResource } from "@/lib/pkm/pkm-domain-resource";
import { ownerStyleFromBranch } from "@/lib/agent/owner-style-settings";
import { useChatOnboardingPickedName } from "@/lib/agent/chat-onboarding/chat-onboarding-session";

/**
 * The name on One's label, in order:
 * 1. the name the owner just picked in onboarding that memory does not hold yet;
 * 2. the saved preferred name;
 * 3. only while memory is re-read after a write, the name shown a moment ago, so
 *    the label never drops to "One" between a save and its refreshed snapshot;
 * 4. "One".
 *
 * Never display another owner's snapshot or information from a locked vault.
 */
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

  const ownerId = canRead ? (user?.uid ?? null) : null;
  const pickedName = useChatOnboardingPickedName(ownerId);
  const savedName =
    ownerId && identity.data?.key.userId === ownerId
      ? ownerStyleFromBranch(identity.data.data.communication_preferences).preferred_name || null
      : null;
  const shownName = pickedName ?? savedName;
  // A failed read must not keep an old name on screen.
  const rereading = Boolean(
    ownerId && !identity.error && (identity.invalidated || identity.loading || identity.refreshing),
  );

  const [lastShown, setLastShown] = useState<{ ownerId: string; name: string } | null>(null);
  useEffect(() => {
    if (!ownerId) setLastShown(null);
    else if (shownName) {
      setLastShown((current) =>
        current?.ownerId === ownerId && current.name === shownName ? current : { ownerId, name: shownName },
      );
    } else if (!rereading) setLastShown(null);
  }, [ownerId, shownName, rereading]);

  if (shownName) return shownName;
  return (rereading && lastShown?.ownerId === ownerId ? lastShown.name : null) ?? "One";
}
