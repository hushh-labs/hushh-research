"use client";

import { useEffect, useState } from "react";
import { Loader2, Lock, ShieldCheck, Database } from "lucide-react";

import { useAuth } from "@/lib/firebase/auth-context";
import { VaultService } from "@/lib/services/vault-service";
import { cn } from "@/lib/utils";
import { resolveVaultAvailabilityState, resolveVaultCapabilityState } from "@/lib/vault/vault-access-policy";
import { useVault } from "@/lib/vault/vault-context";

/**
 * Small, plain-text inline status line (never a decorative Badge) for setup
 * steps that write to the vault-backed PKM. Shows whether the vault is
 * ready to accept a write before the step's action runs, so a failure isn't
 * the first signal the user gets that something about their vault state
 * blocked the save.
 */
export function VaultStatusInline({
  className,
  mode = "informational",
}: {
  className?: string;
  /**
   * "informational" only displays status text and never blocks the caller's
   * own action (used where an action should remain available even while the
   * vault is locked, e.g. starting an OAuth connect flow). "blocking" also
   * exposes `disabled`-worthy state via the rendered copy for the caller to
   * gate its own primary action on.
   */
  mode?: "informational" | "blocking";
}) {
  const { user, loading: authLoading } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);

  useEffect(() => {
    // No user is not "no lock". Firebase restores a session from disk on every
    // load, so `user` is null for the whole of that window — and answering
    // `false` there rendered "Lock required" at somebody who is signed in and
    // holds a lock. Unknown stays unknown until an identity exists.
    if (!user) {
      setHasVault(null);
      setCheckFailed(false);
      return;
    }
    let isMounted = true;
    setCheckFailed(false);
    VaultService.checkVault(user.uid)
      .then((exists) => {
        if (isMounted) setHasVault(exists);
      })
      .catch((error) => {
        // A read that threw is not an answer of "no". Without this the promise
        // rejected unhandled and `hasVault` stayed null for good, so the
        // component sat on its unknown branch with nothing to say why.
        console.warn("[VaultStatusInline] Could not check lock state:", error);
        if (isMounted) setCheckFailed(true);
      });
    return () => {
      isMounted = false;
    };
  }, [user]);

  const availability = resolveVaultAvailabilityState({
    hasVault,
    isVaultUnlocked,
    vaultKey,
    vaultOwnerToken,
    authLoading: authLoading || !user,
    presenceFailed: checkFailed,
  });

  if (availability.canMutateSecureData) {
    return (
      <p
        className={cn(
          "type-footnote flex items-center gap-1.5 text-muted-foreground",
          className,
        )}
      >
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        Unlocked
      </p>
    );
  }

  if (availability.needsUnlock) {
    return (
      <p
        className={cn(
          "type-footnote flex items-center gap-1.5 text-muted-foreground",
          mode === "blocking" && "text-amber-700 dark:text-amber-400",
          className,
        )}
      >
        <Lock className="h-3.5 w-3.5 shrink-0" />
        Locked, unlock to continue
      </p>
    );
  }

  if (availability.needsVaultCreation) {
    return (
      <p
        className={cn(
          "type-footnote flex items-center gap-1.5 text-muted-foreground",
          mode === "blocking" && "text-amber-700 dark:text-amber-400",
          className,
        )}
      >
        <Database className="h-3.5 w-3.5 shrink-0" />
        Lock required
      </p>
    );
  }

  // A read that failed used to fall through to the spinner below and stay
  // there. Name the fault instead: an endless "Checking…" is indistinguishable
  // from a slow network, and the person has no way to know to try again.
  if (availability.vaultCheckFailed) {
    return (
      <p
        className={cn(
          "type-footnote flex items-center gap-1.5 text-muted-foreground",
          mode === "blocking" && "text-amber-700 dark:text-amber-400",
          className,
        )}
      >
        <Lock className="h-3.5 w-3.5 shrink-0" />
        Couldn&apos;t check your lock
      </p>
    );
  }

  return (
    <p
      className={cn(
        "type-footnote flex items-center gap-1.5 text-muted-foreground",
        className,
      )}
    >
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      Checking…
    </p>
  );
}

export function useVaultWriteReady(): boolean {
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  return resolveVaultCapabilityState({
    isVaultUnlocked,
    vaultKey,
    vaultOwnerToken,
  }).canMutateSecureData;
}
