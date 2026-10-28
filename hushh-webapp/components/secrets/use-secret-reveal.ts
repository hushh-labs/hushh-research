"use client";

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";

import { useAuth } from "@/hooks/use-auth";
import { SecretsVaultService } from "@/lib/pkm/secrets-vault-service";
import { useVault } from "@/lib/vault/vault-context";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";

/**
 * Reveal state for the Secrets card. A value is decrypted only with an
 * unlocked vault, held in component memory, and dropped the moment the vault
 * locks. Never logged, never stored, never sent anywhere.
 */
export function useSecretReveal(active = true) {
  const { userId } = useAuth();
  const { vaultKey, getVaultOwnerToken } = useVault();
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [snapshot, setSnapshot] = useState<{ uid: string | null; key: string | null; epoch: number; values: Record<string, string>; busy: string | null }>(
    { uid: null, key: null, epoch, values: {}, busy: null });
  const requests = useRef(new Map<string, symbol>());
  const mounted = useRef(false);
  const token = getVaultOwnerToken();
  const locked = !active || !userId || !vaultKey || !token || privacy?.shielded || privacy?.appIsActive === false ||
    Capacitor.isNativePlatform() && !privacy;
  const uid = userId;
  const current = useRef({ uid, vaultKey, epoch, active });

  useLayoutEffect(() => {
    current.current = { uid, vaultKey, epoch, active };
    mounted.current = true;
    const pending = requests.current;
    const conceal = () => {
      pending.clear();
      setSnapshot({ uid, key: vaultKey, epoch, values: {}, busy: null });
    };
    conceal();
    const visibility = () => { if (document.visibilityState === "hidden") conceal(); };
    const unsubscribe = subscribeNativePrivacyObservation(() => {
      const privacy = nativePrivacyObservation().state;
      if (privacy?.shielded || privacy?.appIsActive === false) conceal();
    });
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false;
      pending.clear();
      unsubscribe(); document.removeEventListener("visibilitychange", visibility);
    };
  }, [uid, vaultKey, epoch, locked, active]);

  const reveal = useCallback(
    async (secretId: string): Promise<void> => {
      const owner = snapshotValidatedAuthSessionOwner();
      const privacy = nativePrivacyObservation().state;
      const vaultOwnerToken = getVaultOwnerToken();
      if (!active || !current.current.active || !uid || !vaultKey || !mounted.current || owner?.userId !== uid || requests.current.has(secretId) ||
          !vaultOwnerToken || Capacitor.isNativePlatform() && !privacy ||
          current.current.uid !== uid || current.current.vaultKey !== vaultKey || current.current.epoch !== epoch ||
          snapshotVaultSessionEpoch() !== epoch ||
          document.visibilityState === "hidden" || privacy?.shielded || privacy?.appIsActive === false) return;
      const request = Symbol();
      requests.current.set(secretId, request);
      const acceptsResult = () => {
        const privacy = nativePrivacyObservation().state;
        return mounted.current && current.current.active && requests.current.get(secretId) === request &&
          current.current.uid === uid && current.current.vaultKey === vaultKey && current.current.epoch === epoch &&
          snapshotVaultSessionEpoch() === epoch && isValidatedAuthSessionOwnerCurrent(owner) &&
          !!getVaultOwnerToken() && document.visibilityState !== "hidden" && !privacy?.shielded && privacy?.appIsActive !== false &&
          (!Capacitor.isNativePlatform() || !!privacy);
      };
      setSnapshot(previous => ({ ...previous, busy: secretId }));
      try {
        const value = await SecretsVaultService.revealSecret({
          userId: uid,
          vaultKey,
          vaultOwnerToken,
          secretId,
        });
        if (value && acceptsResult()) setSnapshot(previous => ({ ...previous, values: { ...previous.values, [secretId]: value } }));
      } catch {
        // A failed decrypt never surfaces secret material in an error path.
      } finally {
        if (mounted.current && requests.current.get(secretId) === request) {
          requests.current.delete(secretId);
          setSnapshot(previous => previous.busy === secretId ? { ...previous, busy: null } : previous);
        }
      }
    },
    [getVaultOwnerToken, uid, vaultKey, epoch, active],
  );

  const hide = useCallback((secretId: string) => {
    if (!mounted.current || current.current.uid !== uid || current.current.vaultKey !== vaultKey ||
        current.current.epoch !== epoch || snapshotVaultSessionEpoch() !== epoch) return;
    requests.current.delete(secretId); // Hide also cancels a pending reveal.
    setSnapshot((current) => {
      const next = { ...current.values };
      delete next[secretId];
      return { ...current, values: next, busy: current.busy === secretId ? null : current.busy };
    });
  }, [uid, vaultKey, epoch]);

  return {
    locked,
    revealed: !locked && snapshot.uid === uid && snapshot.key === vaultKey && snapshot.epoch === epoch ? snapshot.values : {},
    busyId: snapshot.uid === uid && snapshot.key === vaultKey && snapshot.epoch === epoch ? snapshot.busy : null,
    reveal,
    hide,
    vaultContext: { userId: userId ?? "", vaultKey, vaultOwnerToken: token },
  };
}
