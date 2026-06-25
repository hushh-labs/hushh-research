"use client";

import { useEffect, useMemo, useState } from "react";

import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { useConsentPendingSummaryCount } from "@/lib/consent/use-consent-pending-summary-count";
import {
  resolveAllCapabilitySetupStates,
  type CapabilityStatus,
  type CapabilitySetupInputs,
} from "@/lib/services/capability-setup-state-service";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import { KaiProfileService, type KaiProfileV2 } from "@/lib/services/kai-profile-service";
import {
  PreVaultUserStateService,
  type PreVaultUserState,
} from "@/lib/services/pre-vault-user-state-service";
import { AuthService } from "@/lib/services/auth-service";

/**
 * useCapabilitySetupStates — the single hook that feeds the resolver from live
 * app state.
 *
 * TIERED ACQUISITION (deliberate, to avoid over-fetching)
 * - ALWAYS (cheap, coarse): auth, vault-unlocked flag, the pre-vault bootstrap
 *   mirror, and the live pending-consent count. This is all the `/one`
 *   dashboard needs and costs at most one already-cached bootstrap call.
 * - OPT-IN (expensive, accurate): the decrypted Kai profile and OAuth
 *   connection status (Gmail, Connected Systems). The `/one/setup` flow opts
 *   into these via `enrichVault` / `enrichOauth` so it can make honest
 *   skip-vs-continue decisions; the dashboard does not pay that cost.
 *
 * SECURITY: the decrypted Kai profile is held only in this hook's state
 * (memory) and passed straight into the pure resolver. It is never written to
 * the unencrypted pre-vault mirror.
 */
export interface UseCapabilitySetupStatesOptions {
  /** Resolve real vault-backed state (decrypts the Kai profile). Default false. */
  enrichVault?: boolean;
  /** Resolve OAuth connection status (Gmail, Connected Systems). Default false. */
  enrichOauth?: boolean;
}

export interface UseCapabilitySetupStatesResult {
  statuses: CapabilityStatus[];
  byId: Record<string, CapabilityStatus>;
  /** True until the always-on coarse inputs (bootstrap) have resolved once. */
  isLoading: boolean;
  /** True while opted-in enrichment (vault/oauth) is still in flight. */
  isEnriching: boolean;
}

export function useCapabilitySetupStates(
  options: UseCapabilitySetupStatesOptions = {}
): UseCapabilitySetupStatesResult {
  const { enrichVault = false, enrichOauth = false } = options;

  const { user } = useAuth();
  const { isVaultUnlocked, getVaultKey, getVaultOwnerToken } = useVault();
  const pendingConsents = useConsentPendingSummaryCount();

  const [preVaultState, setPreVaultState] = useState<PreVaultUserState | null>(null);
  const [bootstrapResolved, setBootstrapResolved] = useState(false);
  const [kaiProfile, setKaiProfile] = useState<KaiProfileV2 | null>(null);
  const [oauthConnections, setOauthConnections] = useState<
    Partial<Record<string, boolean>>
  >({});
  const [enrichingVault, setEnrichingVault] = useState(false);
  const [enrichingOauth, setEnrichingOauth] = useState(false);

  const userId = user?.uid ?? null;

  // ---- ALWAYS: coarse pre-vault mirror ------------------------------------
  useEffect(() => {
    if (!userId) {
      setPreVaultState(null);
      setBootstrapResolved(false);
      return;
    }
    let cancelled = false;
    PreVaultUserStateService.bootstrapState(userId)
      .then((state) => {
        if (!cancelled) setPreVaultState(state);
      })
      .catch(() => {
        // Leave preVaultState null → resolver yields `unknown`, never a
        // fabricated default. A bootstrap blip must not re-trigger setup flows.
        if (!cancelled) setPreVaultState(null);
      })
      .finally(() => {
        if (!cancelled) setBootstrapResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // ---- OPT-IN: decrypted Kai profile (vault-backed) -----------------------
  useEffect(() => {
    if (!enrichVault || !userId || !isVaultUnlocked) {
      setKaiProfile(null);
      return;
    }
    const vaultKey = getVaultKey();
    if (!vaultKey) {
      setKaiProfile(null);
      return;
    }
    let cancelled = false;
    setEnrichingVault(true);
    KaiProfileService.getProfile({
      userId,
      vaultKey,
      vaultOwnerToken: getVaultOwnerToken() ?? undefined,
    })
      .then((profile) => {
        if (!cancelled) setKaiProfile(profile);
      })
      .catch(() => {
        // Leave null → finance falls back to the coarse mirror, never guesses.
        if (!cancelled) setKaiProfile(null);
      })
      .finally(() => {
        if (!cancelled) setEnrichingVault(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enrichVault, userId, isVaultUnlocked, getVaultKey, getVaultOwnerToken]);

  // ---- OPT-IN: OAuth connection status ------------------------------------
  useEffect(() => {
    if (!enrichOauth || !userId) {
      setOauthConnections({});
      return;
    }
    let cancelled = false;
    setEnrichingOauth(true);
    (async () => {
      const next: Partial<Record<string, boolean>> = {};
      try {
        const idToken = await AuthService.getIdToken();
        if (idToken) {
          const gmail = await GmailReceiptsService.getStatus({ idToken, userId }).catch(
            () => null
          );
          if (gmail) next.gmail = gmail.connected === true && gmail.revoked !== true;
        }
      } catch {
        // Absent key → resolver reports `blocked` on oauth (honest, actionable).
      }
      if (!cancelled) setOauthConnections(next);
      if (!cancelled) setEnrichingOauth(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [enrichOauth, userId]);

  const inputs = useMemo<CapabilitySetupInputs>(
    () => ({
      isAuthenticated: Boolean(userId),
      isVaultUnlocked,
      preVaultState,
      kaiProfile,
      pendingConsents,
      oauthConnections,
    }),
    [userId, isVaultUnlocked, preVaultState, kaiProfile, pendingConsents, oauthConnections]
  );

  const statuses = useMemo(() => resolveAllCapabilitySetupStates(inputs), [inputs]);

  const byId = useMemo(() => {
    const map: Record<string, CapabilityStatus> = {};
    for (const status of statuses) map[status.id] = status;
    return map;
  }, [statuses]);

  return {
    statuses,
    byId,
    isLoading: Boolean(userId) && !bootstrapResolved,
    isEnriching: enrichingVault || enrichingOauth,
  };
}
