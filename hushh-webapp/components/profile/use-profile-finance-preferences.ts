"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { KaiProfileService, type KaiProfileV2 } from "@/lib/services/kai-profile-service";
import { useKaiPreferencesWizard, type WizardCompletePayload } from "@/components/kai/onboarding/use-kai-preferences-wizard";

type Ports = { userId: string | null; vaultKey: string | null; vaultOwnerToken: string | null; canEdit: boolean; active?: boolean };

/** One load, wizard and confirmed writer for both presentations. A failed
 * follow-up read cannot turn an acknowledged save into an apparent failure. */
export function useProfileFinancePreferences(ports: Ports) {
  const epoch = snapshotVaultSessionEpoch();
  const visit = useMemo(() => ({ live: false, pending: false, read: 0, owner: snapshotValidatedAuthSessionOwner(),
    userId: ports.userId, key: ports.vaultKey, token: ports.vaultOwnerToken, epoch,
    enabled: ports.active !== false && ports.canEdit }),
  [ports.userId, ports.vaultKey, ports.vaultOwnerToken, ports.canEdit, ports.active, epoch]);
  type Value = { profile: KaiProfileV2 | null; loading: boolean; saving: boolean; error: string | null; notice: string | null };
  const [stored, setStored] = useState<{ visit: typeof visit; value: Value } | null>(null);
  const value: Value = stored?.visit === visit ? stored.value : { profile: null, loading: visit.enabled, saving: false, error: null, notice: null };
  const current = useCallback(() => visit.live && visit.enabled && !!visit.owner && visit.owner.userId === visit.userId &&
    isValidatedAuthSessionOwnerCurrent(visit.owner) && snapshotVaultSessionEpoch() === visit.epoch, [visit]);
  const write = useCallback((update: Partial<Value>) => {
    if (!current()) return;
    setStored(previous => ({ visit, value: { ...(previous?.visit === visit ? previous.value :
      { profile: null, loading: false, saving: false, error: null, notice: null }), ...update } }));
  }, [current, visit]);
  useLayoutEffect(() => { visit.live = true; return () => { visit.live = false; visit.read++; }; }, [visit]);
  const load = useCallback(async () => {
    if (!current() || !visit.userId || !visit.key || !visit.token || visit.pending) return;
    const read = ++visit.read;
    write({ loading: true, error: null });
    try {
      const profile = await KaiProfileService.getProfile({ userId: visit.userId, vaultKey: visit.key, vaultOwnerToken: visit.token });
      if (current() && visit.read === read) write({ profile, loading: false });
    } catch {
      if (current() && visit.read === read) write({ profile: null, loading: false, error: "Couldn't load Finance preferences. Try again." });
    }
  }, [current, visit, write]);
  useEffect(() => { void load(); }, [load]);
  const save = async (payload: WizardCompletePayload) => {
    if (!current() || !visit.userId || !visit.key || !visit.token || visit.pending) throw new Error("FINANCE_PREFERENCES_UNAVAILABLE");
    visit.pending = true; visit.read++;
    write({ saving: true, error: null, notice: null });
    try {
      const profile = await KaiProfileService.savePreferences({ userId: visit.userId, vaultKey: visit.key, vaultOwnerToken: visit.token,
        updates: { investment_horizon: payload.investment_horizon, drawdown_response: payload.drawdown_response,
          volatility_preference: payload.volatility_preference }, mode: "edit", horizonAnchorChoice: payload.horizonAnchorChoice });
      if (current()) { write({ profile, saving: false, notice: "Preferences updated" }); toast.success("Preferences updated"); }
    } catch {
      if (current()) { write({ saving: false, error: "Couldn't save preferences. Please retry." }); toast.error("Couldn't save preferences. Please retry."); }
      throw new Error("FINANCE_PREFERENCES_SAVE_FAILED");
    } finally { visit.pending = false; }
  };
  const wizard = useKaiPreferencesWizard({ enabled: visit.enabled && !!value.profile && !value.loading,
    resetKey: value.profile ?? visit, mode: "edit", isSubmitting: value.saving,
    initialAnswers: value.profile?.preferences, onComplete: save });
  return { ...value, available: visit.enabled, wizard, retry: load };
}
export type ProfileFinancePreferencesModel = ReturnType<typeof useProfileFinancePreferences>;
