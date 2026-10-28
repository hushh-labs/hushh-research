"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { getAuthSessionGeneration, isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { EmailVerificationRequired, MarketingPreferenceService, type EmailFrequency, type MarketingPreference } from "@/lib/services/marketing-preference-service";

export function useMarketingPreference(userId: string | null, surface: "setup" | "account") {
  const generation = getAuthSessionGeneration();
  const scope = useMemo(() => ({ active: false, userId, generation, owner: snapshotValidatedAuthSessionOwner(),
    sequence: 0, action: 0, saving: false, toast: undefined as ReturnType<typeof morphyToast.promise> | undefined }), [userId, generation]);
  useLayoutEffect(() => {
    scope.active = true;
    const retireToast = () => {
      const toastId = scope.toast?.valueOf();
      if (typeof toastId === "string" || typeof toastId === "number") morphyToast.dismiss(toastId);
      scope.toast = undefined;
    };
    const unsubscribe = Capacitor.isNativePlatform() ? subscribeNativePrivacyObservation(retireToast) : () => undefined;
    return () => { scope.active = false; scope.sequence++; scope.action++; retireToast(); unsubscribe(); };
  }, [scope]);
  const current = useCallback(() => scope.active && !!scope.owner && scope.owner.userId === userId &&
    scope.owner.generation === generation && isValidatedAuthSessionOwnerCurrent(scope.owner), [scope, userId, generation]);
  const canAct = () => {
    const privacy = nativePrivacyObservation().state;
    return current() && (!Capacitor.isNativePlatform() || !!privacy && privacy.appIsActive && !privacy.shielded);
  };
  type Snapshot = { scope: typeof scope; value: MarketingPreference | null; enabledDraft: boolean;
    frequencyDraft: EmailFrequency; loading: boolean; busy: boolean; error: string | null; saved: boolean };
  const empty = useCallback((): Snapshot => ({ scope, value: null, enabledDraft: false,
    frequencyDraft: "weekly", loading: !!userId, busy: false, error: null, saved: false }), [scope, userId]);
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const visible = snapshot.scope === scope ? snapshot : empty();
  const action = scope.action;
  const refresh = useCallback(async () => {
    if (!current() || scope.saving) return;
    const attempt = ++scope.sequence;
    scope.action++;
    const isCurrent = () => current() && scope.sequence === attempt;
    setSnapshot(empty());
    try {
      const value = await MarketingPreferenceService.read(userId!, isCurrent);
      if (isCurrent()) setSnapshot({ ...empty(), value, enabledDraft: value.enabled, frequencyDraft: value.frequency, loading: false });
    } catch {
      if (isCurrent()) setSnapshot({ ...empty(), loading: false, error: "Couldn’t load email preferences. Try again later." });
    }
  }, [current, scope, empty, userId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const save = async (enabled: boolean, frequency: EmailFrequency) => {
    if (!canAct() || action !== scope.action || !visible.value || visible.loading || scope.saving) return;
    const attempt = scope.sequence;
    const isCurrent = () => current() && scope.sequence === attempt;
    const native = Capacitor.isNativePlatform(), privacy = nativePrivacyObservation();
    const effectCurrent = () => {
      const observed = nativePrivacyObservation();
      return isCurrent() && (!native || observed.epoch === privacy.epoch &&
        observed.state?.generation === privacy.state?.generation && !!observed.state?.appIsActive && !observed.state.shielded);
    };
    scope.saving = true;
    scope.action++;
    setSnapshot((s) => ({ ...s, busy: true, error: null, saved: false }));
    try {
      const operation = MarketingPreferenceService.save(userId!, effectCurrent, visible.value, enabled, frequency, surface);
      scope.toast = morphyToast.promise(operation, { isCurrent: effectCurrent, loading: "Saving email preference…", success: "Email preference saved.",
        error: "Couldn’t confirm the email preference. Review the form before trying again." });
      const value = await operation;
      if (isCurrent()) setSnapshot((s) => ({ ...s, value, enabledDraft: value.enabled, frequencyDraft: value.frequency, busy: false, saved: true }));
    } catch (error) {
      if (isCurrent()) {
        const verificationRequired = error instanceof EmailVerificationRequired;
        setSnapshot((s) => ({ ...s, busy: false, value: verificationRequired ? s.value : null,
          error: verificationRequired ? "Verify your account email before subscribing. You can still save an opt-out." :
            "Email preference was not confirmed. Refresh before choosing again." }));
      }
    } finally {
      if (isCurrent()) scope.saving = false;
    }
  };
  return { value: visible.value, loading: visible.loading, enabledDraft: visible.enabledDraft,
    frequencyDraft: visible.frequencyDraft,
    edit: (enabled: boolean, frequency: EmailFrequency) => {
      if (!canAct() || action !== scope.action || !visible.value || scope.saving) return;
      scope.action++;
      setSnapshot((s) => s.scope === scope ? { ...s, enabledDraft: enabled, frequencyDraft: frequency, saved: false } : s);
    },
    busy: visible.busy, error: visible.error, saved: visible.saved, refresh, save };
}
