"use client";

import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";

export function useFinanceShareContext() {
  const auth = useAuth();
  const vault = useVault();
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const latest = useRef({ auth, vault });
  useLayoutEffect(() => { latest.current = { auth, vault }; }, [auth, vault]);
  const capture = useCallback((): FinanceShareContext | null => {
    const { auth: a, vault: v } = latest.current;
    const owner = snapshotValidatedAuthSessionOwner();
    const key = v.getVaultKey();
    const token = v.getVaultOwnerToken();
    const generation = snapshotVaultSessionEpoch();
    if (!owner || !a.user || a.loading || a.sessionVerificationRequired || !key || !token) return null;
    return { userId: owner.userId, vaultKey: key, vaultOwnerToken: token,
      getIdToken: () => a.user!.getIdToken(),
      isCurrent: () => isVaultSessionEpochCurrent(generation) && isValidatedAuthSessionOwnerCurrent(owner)
        && !document.hidden
        && latest.current.vault.getVaultKey() === key && latest.current.vault.getVaultOwnerToken() === token
        && !latest.current.auth.loading && !latest.current.auth.sessionVerificationRequired,
    };
  }, []);
  return { capture, session: `${auth.userId || ""}:${epoch}`, ready: Boolean(!auth.loading && !auth.sessionVerificationRequired && vault.vaultKey && vault.vaultOwnerToken) };
}
