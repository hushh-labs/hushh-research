"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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
import { CapabilityTourService } from "@/lib/services/capability-tour-service";

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
  /**
   * Record that the user has explored an explore-only capability. Updates the
   * local store, optimistically flips the in-memory status to "Explored", and
   * best-effort mirrors the full set to the durable backend for cross-device.
   */
  markExplored: (capabilityId: string) => Promise<void>;
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
  const [exploredIds, setExploredIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );

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

  // ---- ALWAYS: explore-only tour set (local-first, cheap) -----------------
  // Local store is the source of truth; load it immediately so explore-only
  // tiles resolve correctly on first paint. Cost is a single Preferences read.
  useEffect(() => {
    if (!userId) {
      setExploredIds(new Set<string>());
      return;
    }
    let cancelled = false;
    CapabilityTourService.loadExploredIds(userId)
      .then((ids) => {
        if (!cancelled) setExploredIds(new Set(ids));
      })
      .catch(() => {
        // Read failure → treat as nothing explored (tiles stay "Explore"),
        // never crash the resolver.
        if (!cancelled) setExploredIds(new Set<string>());
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // ---- ALWAYS: fold the durable backend mirror into the explored set ------
  // Once the bootstrap mirror resolves, union any server-recorded explored ids
  // (cross-device) into the local set so a capability explored on another
  // device shows as "Explored" here too. Union semantics: never drop a locally
  // explored id because of a stale server snapshot.
  useEffect(() => {
    if (!userId) return;
    const serverIds = preVaultState?.setupCapabilityIds;
    if (!serverIds || serverIds.length === 0) return;
    let cancelled = false;
    CapabilityTourService.mergeFromServer(userId, serverIds)
      .then((state) => {
        if (!cancelled) setExploredIds(new Set(state.exploredIds));
      })
      .catch(() => {
        // Local set remains authoritative on this device.
      });
    return () => {
      cancelled = true;
    };
  }, [userId, preVaultState?.setupCapabilityIds]);

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

  const markExplored = useCallback(
    async (capabilityId: string) => {
      const id = capabilityId.trim();
      if (!userId || id.length === 0) return;
      // Optimistic: flip the in-memory status immediately so the tile reads
      // "Explored" without waiting on storage.
      setExploredIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      // Local store is the source of truth; persist there first.
      const state = await CapabilityTourService.markExplored(userId, id).catch(
        () => null
      );
      const nextIds = state?.exploredIds ?? [id];
      // Best-effort durable mirror for cross-device. A failure leaves the local
      // copy authoritative on this device.
      PreVaultUserStateService.syncSetupCapabilities(userId, nextIds).catch(() => {
        // swallow — local copy already recorded the exploration.
      });
    },
    [userId]
  );

  const inputs = useMemo<CapabilitySetupInputs>(
    () => ({
      isAuthenticated: Boolean(userId),
      isVaultUnlocked,
      preVaultState,
      kaiProfile,
      pendingConsents,
      oauthConnections,
      exploredCapabilityIds: exploredIds,
    }),
    [
      userId,
      isVaultUnlocked,
      preVaultState,
      kaiProfile,
      pendingConsents,
      oauthConnections,
      exploredIds,
    ]
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
    markExplored,
  };
}
