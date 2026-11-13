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
 * 3. while memory is re-read, the name shown a moment ago; if the read fails,
 *    only the last confirmed saved name from this unlocked owner;
 * 4. "One".
 *
 * Never display another owner's snapshot or information from a locked vault.
 */
export function useOneDisplayName(enabled = true): string {
  const { userId } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const canRead = Boolean(enabled && userId && isVaultUnlocked && vaultKey && vaultOwnerToken);
  const revision = usePkmDomainChangeRevision(userId, "identity");
  const identity = usePkmDomainResource({
    userId: userId ?? "",
    domain: "identity",
    vaultKey,
    vaultOwnerToken,
    enabled: canRead,
  });
  const { refresh } = identity;
  useEffect(() => {
    if (canRead && revision > 0) void refresh({ force: true });
  }, [canRead, revision, refresh]);

  const ownerId = canRead ? userId : null;
  const pickedName = useChatOnboardingPickedName(ownerId);
  const hasOwnerSnapshot = Boolean(ownerId && identity.data?.key.userId === ownerId);
  const savedName =
    hasOwnerSnapshot
      ? ownerStyleFromBranch(identity.data?.data.communication_preferences).preferred_name || null
      : null;
  const shownName = pickedName ?? savedName;
  // A failed read cannot confirm that the owner removed their saved name.
  // Keep only confirmed PKM values through errors, never an unsaved draft.
  const [confirmed, setConfirmed] = useState<{ ownerId: string; vaultKey: string; name: string } | null>(null);
  useEffect(() => {
    if (!ownerId || !vaultKey) setConfirmed(null);
    else if (hasOwnerSnapshot && !identity.error) {
      setConfirmed((current) => savedName
        ? current?.ownerId === ownerId && current.vaultKey === vaultKey && current.name === savedName
          ? current : { ownerId, vaultKey, name: savedName }
        : null);
    } else if (!identity.error && !identity.invalidated && !identity.loading && !identity.refreshing) {
      setConfirmed(null);
    } else {
      setConfirmed((current) => current?.ownerId === ownerId && current.vaultKey === vaultKey ? current : null);
    }
  }, [ownerId, vaultKey, hasOwnerSnapshot, savedName, identity.error, identity.invalidated, identity.loading, identity.refreshing]);
  const rereading = Boolean(
    ownerId && !identity.error && (identity.invalidated || identity.loading || identity.refreshing),
  );

  const [lastShown, setLastShown] = useState<{ ownerId: string; vaultKey: string; name: string } | null>(null);
  useEffect(() => {
    if (!ownerId || !vaultKey) setLastShown(null);
    else if (shownName) {
      setLastShown((current) =>
        current?.ownerId === ownerId && current.vaultKey === vaultKey && current.name === shownName
          ? current : { ownerId, vaultKey, name: shownName },
      );
    } else if (!rereading) setLastShown(null);
  }, [ownerId, vaultKey, shownName, rereading]);

  if (shownName) return shownName;
  if (rereading && lastShown?.ownerId === ownerId && lastShown.vaultKey === vaultKey) return lastShown.name;
  return ((rereading || identity.error) && confirmed?.ownerId === ownerId && confirmed.vaultKey === vaultKey
    ? confirmed.name : null) ?? "One";
}
