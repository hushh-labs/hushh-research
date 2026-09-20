"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { REQUEST_DURATION_OPTIONS } from "@/lib/agent/action-directive-summary";
import { PersonProfileService } from "@/lib/services/person-profile-service";
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";

export type PersonInformationDraft = {
  scopeRefs: string[];
  purpose: string;
  durationHours: number;
};

/** One explicit-confirmation submission path for Profile and inline Chat.
 * Keys and credentials stay in this mount's memory. Retries of an unchanged
 * draft reconcile a lost acknowledgement instead of creating another request.
 */
export function usePersonInformationRequest(personRef: string) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const retry = useRef<{ fingerprint: string; key: string } | null>(null);
  const available = Boolean(user && personRef && isVaultUnlocked && vaultKey && vaultOwnerToken);

  useEffect(() => {
    generation.current += 1;
    abortRef.current?.abort();
    inFlight.current = false;
    retry.current = null;
    setPending(false);
    setError(null);
    return () => {
      generation.current += 1;
      abortRef.current?.abort();
    };
  }, [personRef, user?.uid, vaultKey, isVaultUnlocked]);

  async function submit(draft: PersonInformationDraft): Promise<boolean> {
    if (inFlight.current) return false;
    if (!user || !vaultKey || !vaultOwnerToken || !isVaultUnlocked || !personRef) {
      setError("Unlock your vault before requesting information.");
      return false;
    }
    const purpose = draft.purpose.trim();
    const scopeRefs = [...new Set(draft.scopeRefs)].sort();
    if (!scopeRefs.length || scopeRefs.length > 50 || purpose.length < 8 || purpose.length > 500
      || !REQUEST_DURATION_OPTIONS.some(option => option.hours === draft.durationHours)) {
      setError("Choose up to 50 fields, explain why you need them, and select an access duration.");
      return false;
    }
    const run = generation.current;
    const fingerprint = JSON.stringify([user.uid, personRef, scopeRefs, purpose, draft.durationHours]);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: crypto.randomUUID() };
    const idempotencyKey = retry.current.key;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    const stale = () => run !== generation.current || controller.signal.aborted;
    try {
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(new Error("Request preparation timed out."));
        controller.signal.addEventListener("abort", aborted, { once: true });
        void (async () => {
          try {
            const connector = await OneKycClientZkService.ensureConnector({ userId: user.uid, vaultKey, vaultOwnerToken });
            if (stale()) return;
            await PersonProfileService.createInformationRequest({
              personRef, scopeRefs, purpose, durationSeconds: draft.durationHours * 3600,
              connectorKeyId: connector.connector_key_id, idempotencyKey, vaultOwnerToken,
              signal: controller.signal,
            });
            // The request mutation is authoritative even if this component
            // becomes stale before its acknowledgement is painted. Invalidate
            // the owner-scoped consent projections from the mutation boundary
            // so Chat, Profile, and Consent Center cannot reuse old state.
            CacheSyncService.onConsentMutated(user.uid);
            resolve();
          } catch (reason) { reject(reason); }
          finally { controller.signal.removeEventListener("abort", aborted); }
        })();
      });
      if (stale()) return false;
      retry.current = null;
      return true;
    } catch {
      if (run === generation.current) {
        setError(controller.signal.aborted
          ? "We could not confirm the request yet. Retry to check the same request."
          : "The request could not be confirmed. Your choices are kept; please try again.");
      }
      return false;
    } finally {
      window.clearTimeout(timeout);
      if (run === generation.current) { inFlight.current = false; setPending(false); }
    }
  }

  return { available, pending, error, submit };
}
