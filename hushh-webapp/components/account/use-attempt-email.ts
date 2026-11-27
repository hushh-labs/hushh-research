"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { getAuthSessionGeneration, isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { EmailVerificationRequired } from "@/lib/services/marketing-preference-service";

import { AttemptEmailService, type AttemptEmailPreference } from "@/lib/services/attempt-email-service";

export function useAttemptEmail(userId: string | null) {
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
  type Snapshot = { scope: typeof scope; value: AttemptEmailPreference | null; enabledDraft: boolean;
    loading: boolean; busy: boolean; error: string | null; saved: boolean };
  const empty = useCallback((): Snapshot => ({ scope, value: null, enabledDraft: false,
    loading: !!userId, busy: false, error: null, saved: false }), [scope, userId]);
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
      const value = await AttemptEmailService.read(userId!, isCurrent);
      if (isCurrent()) setSnapshot({ ...empty(), value, enabledDraft: value.enabled, loading: false });
    } catch {
      if (isCurrent()) setSnapshot({ ...empty(), loading: false, error: "Couldn’t load activity email choices. Try again later." });
    }
  }, [current, scope, empty, userId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const save = async (enabled: boolean) => {
    if (!canAct() || action !== scope.action || !visible.value || visible.loading || scope.saving || enabled && !visible.value.available) return;
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
      const operation = AttemptEmailService.save(userId!, effectCurrent, visible.value, enabled);
      scope.toast = morphyToast.promise(operation, { isCurrent: effectCurrent, loading: "Saving activity email choice…", success: "Activity email choice saved.",
        error: "Couldn’t confirm the activity email choice. Review the form before trying again." });
      const value = await operation;
      if (isCurrent()) setSnapshot((s) => ({ ...s, value, enabledDraft: value.enabled, busy: false, saved: true }));
    } catch (error) {
      if (isCurrent()) {
        const verificationRequired = error instanceof EmailVerificationRequired;
        setSnapshot((s) => ({ ...s, busy: false, value: verificationRequired ? s.value : null,
          error: verificationRequired ? "Verify your account email before subscribing. You can still save an opt-out." :
            "Activity email choice was not confirmed. Refresh before choosing again." }));
      }
    } finally {
      if (isCurrent()) scope.saving = false;
    }
  };
  return { value: visible.value, loading: visible.loading, enabledDraft: visible.enabledDraft,
    edit: (enabled: boolean) => {
      if (!canAct() || action !== scope.action || !visible.value || scope.saving || enabled && !visible.value.available) return;
      scope.action++;
      setSnapshot((s) => s.scope === scope ? { ...s, enabledDraft: enabled, saved: false } : s);
    },
    busy: visible.busy, error: visible.error, saved: visible.saved, refresh, save };
}
