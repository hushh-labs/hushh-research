"use client";

import { Loader2, Lock, ShieldCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import { resolveVaultCapabilityState } from "@/lib/vault/vault-access-policy";
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
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const capability = resolveVaultCapabilityState({
    isVaultUnlocked,
    vaultKey,
    vaultOwnerToken,
  });

  if (capability.canMutateSecureData) {
    return (
      <p
        className={cn(
          "type-footnote flex items-center gap-1.5 text-muted-foreground",
          className,
        )}
      >
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        Vault ready
      </p>
    );
  }

  if (!capability.hasVaultOwnerToken) {
    return (
      <p
        className={cn(
          "type-footnote flex items-center gap-1.5 text-muted-foreground",
          className,
        )}
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        Setting up your vault…
      </p>
    );
  }

  return (
    <p
      className={cn(
        "type-footnote flex items-center gap-1.5 text-muted-foreground",
        mode === "blocking" && "text-amber-700 dark:text-amber-400",
        className,
      )}
    >
      <Lock className="h-3.5 w-3.5 shrink-0" />
      Vault locked, unlock to continue
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
