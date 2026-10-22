"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { nativeDrawers } from "@/lib/capacitor/native-drawers";
import { createNativeDrawerIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { NativeProfileScenePresentation, type NativeProfileSceneActions } from "@/lib/capacitor/native-profile-scene-presentation";
import { NativePasswordFence, validNativePasswordProjection, type NativePasswordIdentity, type NativePasswordProjection,
  type NativePasswordEdit, type NativePasswordAction, type NativePasswordScenePort } from "@/lib/capacitor/native-profile-password-scene";
import { useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { useProfileVaultMethodsModel } from "./use-profile-vault-methods-model";

export function NativeVaultPasswordEditor({ model, userId, destinationId, onFallback }: {
  model: ReturnType<typeof useProfileVaultMethodsModel>; userId: string; destinationId: string; onFallback: () => void;
}) {
  const pathname = usePathname();
  const appearance = useNativeControlAppearance("secondary");
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [phase, setPhase] = useState("checking");
  const [edit, setEdit] = useState<{ identity: NativePasswordIdentity | null; revision: number; composing: boolean }>({ identity: null, revision: 0, composing: false });
  const live = useRef({ model, appearance, privacy, edit, userId, destinationId, onFallback });
  useLayoutEffect(() => { live.current = { model, appearance, privacy, edit, userId, destinationId, onFallback }; });
  type Presentation = NativeProfileScenePresentation<NativePasswordProjection, NativePasswordEdit, NativePasswordAction, undefined>;
  const replica = useRef<{ identity: NativePasswordIdentity; presentation: Presentation; sequence: number; fingerprint: string | null } | null>(null);
  const actions = useCallback((): NativeProfileSceneActions<NativePasswordEdit, NativePasswordAction, undefined> => ({
    edit: event => {
      live.current.model.editPassword("password", event.password);
      live.current.model.editPassword("confirmation", event.confirmation);
      setEdit({ identity: replica.current?.identity ?? null, revision: event.editRevision, composing: event.composing });
    },
    commit: async () => { await live.current.model.savePassword(); return { kind: "retained" }; },
    saved: () => undefined,
    cancel: () => live.current.model.closePassword(),
  }), []);
  const publish = useCallback(() => {
    const current = replica.current, next = live.current;
    if (!current || !next.appearance || !next.privacy || next.privacy.shielded || !next.privacy.appIsActive || !next.model.passphraseOpen) return;
    const edit = next.edit.identity === current.identity ? next.edit : { revision: 0, composing: false };
    const value = { ...current.identity, ...next.appearance, privacyGeneration: next.privacy.generation,
      acknowledgedEditRevision: edit.revision, password: next.model.password, confirmation: next.model.confirmation,
      canSave: !next.model.busy && !next.model.needsRefresh && !edit.composing && next.model.password.length >= 8 && next.model.password === next.model.confirmation,
      busy: next.model.busy };
    const fingerprint = JSON.stringify(value); // Volatile only; never log this value.
    if (fingerprint === current.fingerprint) { current.presentation.refreshActions(actions()); return; }
    if (current.presentation.publish({ ...value, updateSequence: ++current.sequence }, actions())) current.fingerprint = fingerprint;
  }, [actions]);
  const epoch = snapshotVaultSessionEpoch();
  const generation = privacy?.generation, shielded = privacy?.shielded, active = privacy?.appIsActive;
  useEffect(() => {
    if (generation === undefined || shielded || !active) return;
    const base = createNativeDrawerIdentity("profile");
    if (!base) return;
    const identity: NativePasswordIdentity = { ...base, family: "profile", scene: "vault-passphrase", destinationId };
    let current = true;
    const isCurrent = () => current && live.current.userId === userId && live.current.destinationId === destinationId &&
      snapshotValidatedAuthSessionOwner()?.userId === userId && snapshotVaultSessionEpoch() === epoch && nativeDrawerOwnerIsCurrent(identity) &&
      live.current.privacy?.generation === generation && !live.current.privacy.shielded && live.current.privacy.appIsActive;
    const plugin = nativeDrawers as typeof nativeDrawers & NativePasswordScenePort;
    const presentation = new NativeProfileScenePresentation<NativePasswordProjection, NativePasswordEdit, NativePasswordAction, undefined>(identity, {
      source: plugin, apply: state => plugin.applyProfilePasswordScene(state), confirm: action => plugin.confirmProfilePasswordAction(action),
      settle: action => plugin.settleProfilePasswordAction(action), retire: () => plugin.retireProfilePasswordScene(identity),
      edits: listener => plugin.addListener("profilePasswordEdit", listener), choices: listener => plugin.addListener("profilePasswordAction", listener),
    }, new NativePasswordFence(identity), validNativePasswordProjection, isCurrent, phase => {
      if (!current) return;
      setPhase(phase);
      if (phase === "fallback") live.current.onFallback();
    }, false);
    const instance = { identity, presentation, sequence: 0, fingerprint: null as string | null };
    replica.current = instance; setEdit({ identity, revision: 0, composing: false });
    void presentation.listen().then(ready => { if (ready && isCurrent()) publish(); });
    return () => { current = false; if (replica.current === instance) replica.current = null; instance.fingerprint = null; void presentation.retire(); };
  }, [userId, destinationId, epoch, generation, shielded, active, publish]);
  useLayoutEffect(() => { publish(); });
  useBackLayer(pathname, 100, () => {
    const current = replica.current;
    if (!current || live.current.model.busy) return true;
    void current.presentation.retire().then(retired => { if (retired && replica.current === current && nativeDrawerOwnerIsCurrent(current.identity)) live.current.model.closePassword(); });
    return true;
  }, { profile_pane: "1" });
  return <div aria-busy={phase === "checking"} data-native-profile-password-state={phase} />;
}
