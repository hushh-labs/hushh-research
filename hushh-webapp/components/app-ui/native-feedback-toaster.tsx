"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { useSonner } from "sonner";
import { reconcileNativeFeedback, refreshNativeFeedback, retainNativeFeedbackOwner, receiveNativeFeedbackAction, receiveNativeFeedbackEnd, retainNativeFeedbackConsumer } from "@/lib/capacitor/native-feedback";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { Capacitor } from "@capacitor/core";
import { nativeDrawers, observeNativeDrawerIsolation } from "@/lib/capacitor/native-drawers";
import { createNativePresentationIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { snapshotAuthSessionGeneration, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { setNativeShellFeedbackAvailable } from "@/lib/capacitor/native-workspace-presence";

/** Headless Sonner consumer. Native-tagged messages never mount a DOM toaster;
 * native expiry dismisses the same canonical Sonner handle. */
export function NativeFeedbackToaster() {
  return customNativePresentationEnabled() ? <NativeFeedbackConsumer /> : null;
}

function NativeFeedbackConsumer() {
  const { toasts } = useSonner();
  useNativeShellFeedbackOwner();
  useLayoutEffect(() => retainNativeFeedbackConsumer(), []);
  useLayoutEffect(() => {
    reconcileNativeFeedback(toasts);
    return subscribeNativePrivacyObservation(() => reconcileNativeFeedback(toasts));
  }, [toasts]);
  return null;
}

/** The persistent shell is a fallback notification owner, below more specific
 * workspace/form owners. It never owns routes, credentials or feature actions. */
function useNativeShellFeedbackOwner() {
  const auth = useSyncExternalStore(subscribeAuthSessionGeneration, () => snapshotAuthSessionGeneration()?.generation ?? 0, () => 0);
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, snapshotVaultSessionEpoch);
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  useLayoutEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios" || !privacy?.appIsActive || privacy.shielded) return;
    const identity = createNativePresentationIdentity();
    if (!identity) return;
    const plugin = nativeDrawers();
    let active = true;
    const releases: (() => void)[] = [];
    const releaseAll = () => { while (releases.length) releases.pop()?.(); };
    const state = { ...identity, family: "shell" as const, privacyGeneration: privacy.generation,
      updateSequence: 1, title: "", sections: [], open: true, enabled: true, backEnabled: false,
      appearance: "light" as const, accentHex: "#007aff", foregroundHex: "#111111" };
    void (async () => {
      const capabilities = await plugin.getCapabilities();
      if (!active || capabilities.shellFeedback !== true) return;
      const ended = await plugin.addListener("feedbackEnded", receiveNativeFeedbackEnd);
      if (!active) { void ended.remove(); return; }
      releases.push(() => { void ended.remove(); });
      const action = await plugin.addListener("feedbackAction", receiveNativeFeedbackAction);
      if (!active) { void action.remove(); return; }
      releases.push(() => { void action.remove(); });
      releases.push(retainNativeFeedbackOwner({ state: () => state,
        current: () => active && nativeDrawerOwnerIsCurrent(identity), parentRetired: () => !active,
        plugin: { applyFeedback: plugin.applyFeedback?.bind(plugin), retireFeedback: plugin.retireFeedback?.bind(plugin), addListener: plugin.addListener.bind(plugin) } }));
      releases.push(observeNativeDrawerIsolation(refreshNativeFeedback));
      setNativeShellFeedbackAvailable(true);
      refreshNativeFeedback();
    })().catch(() => { releaseAll(); if (active) setNativeShellFeedbackAvailable(false); });
    return () => { active = false; releaseAll(); setNativeShellFeedbackAvailable(false); };
  }, [auth, epoch, privacy?.generation, privacy?.appIsActive, privacy?.shielded]);
}
