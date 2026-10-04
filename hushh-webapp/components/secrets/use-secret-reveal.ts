"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { SecretsVaultService } from "@/lib/pkm/secrets-vault-service";
import { useVault } from "@/lib/vault/vault-context";

/**
 * Reveal state for the Secrets card. A value is decrypted only with an
 * unlocked vault, held in component memory, and dropped the moment the vault
 * locks. Never logged, never stored, never sent anywhere.
 */
export function useSecretReveal() {
  const { user } = useAuth();
  const { vaultKey, getVaultOwnerToken } = useVault();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const locked = !user?.uid || !vaultKey;

  useEffect(() => {
    if (locked) setRevealed({});
  }, [locked]);

  const reveal = useCallback(
    async (secretId: string): Promise<void> => {
      if (!user?.uid || !vaultKey) return;
      setBusyId(secretId);
      try {
        const value = await SecretsVaultService.revealSecret({
          userId: user.uid,
          vaultKey,
          vaultOwnerToken: getVaultOwnerToken(),
          secretId,
        });
        if (value) setRevealed((current) => ({ ...current, [secretId]: value }));
      } catch {
        // A failed decrypt never surfaces secret material in an error path.
      } finally {
        setBusyId(null);
      }
    },
    [getVaultOwnerToken, user?.uid, vaultKey],
  );

  const hide = useCallback((secretId: string) => {
    setRevealed((current) => {
      const next = { ...current };
      delete next[secretId];
      return next;
    });
  }, []);

  return {
    locked,
    revealed,
    busyId,
    reveal,
    hide,
    vaultContext: { userId: user?.uid ?? "", vaultKey, vaultOwnerToken: getVaultOwnerToken() },
  };
}
