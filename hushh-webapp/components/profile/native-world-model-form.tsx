"use client";

import { nativeProfileSceneCanPrepare, nativeProfileActionsAllowed } from "@/lib/capacitor/native-profile-preparation";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { nativeDrawers } from "@/lib/capacitor/native-drawers";
import { createNativeDrawerIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { NativeProfileScenePresentation, type NativeProfileSceneActions } from "@/lib/capacitor/native-profile-scene-presentation";
import { NativeWorldModelFence, validNativeWorldModelProjection, type NativeWorldModelIdentity, type NativeWorldModelProjection,
  type NativeWorldModelEdit, type NativeWorldModelAction, type NativeWorldModelScenePort, type WorldModelForm } from "@/lib/capacitor/native-profile-world-model-scene";
import { useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

export type NativeWorldModelFormModel = {
  /** Opaque visit, not a statement ID or source URL. Replacing it retires the editor. */
  id: string; owner: string; ready: boolean; form: WorldModelForm; revision: number; busy: boolean; error: string | null;
  canSave: boolean; change: (form: WorldModelForm) => void; commit: () => Promise<boolean>; completed: () => void; close: () => void; fallback: () => void;
};
type Presentation = NativeProfileScenePresentation<NativeWorldModelProjection, NativeWorldModelEdit, NativeWorldModelAction, undefined>;

/** Complete owned form above Profile and chrome. The feature supplies the same
 * validated operation as web; this adapter only mirrors private draft state. */
export function NativeWorldModelForm({ model, destinationId }: { model: NativeWorldModelFormModel; destinationId: string }) {
  const pathname = usePathname(), appearance = useNativeControlAppearance("secondary");
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [phase, setPhase] = useState("checking");
  const [edit, setEdit] = useState<{ identity: NativeWorldModelIdentity | null; revision: number; composing: boolean }>({ identity: null, revision: 0, composing: false });
  const live = useRef({ model, appearance, privacy, edit, destinationId });
  useLayoutEffect(() => { live.current = { model, appearance, privacy, edit, destinationId }; });
  const replica = useRef<{ identity: NativeWorldModelIdentity; presentation: Presentation; sequence: number; fingerprint: string | null } | null>(null);
  const actions = useCallback((): NativeProfileSceneActions<NativeWorldModelEdit, NativeWorldModelAction, undefined> => ({
    edit: event => {
      live.current.model.change(event);
      setEdit({ identity: replica.current?.identity ?? null, revision: event.editRevision, composing: event.composing });
    },
    // "saved" is the presentation protocol's successful completion, not a
    // claim that reading source pages confirmed or persisted any fact.
    commit: async () => await live.current.model.commit() ? { kind: "saved", value: undefined } : { kind: "retained" },
    saved: () => live.current.model.completed(), cancel: () => live.current.model.close(),
  }), []);
  const publish = useCallback(() => {
    const current = replica.current, next = live.current;
    if (!current || !next.appearance || !next.model.ready || !next.privacy || !nativeProfileSceneCanPrepare(next.privacy, current.identity.scene, current.identity.destinationId)) return;
    const edit = next.edit.identity === current.identity ? next.edit : { revision: 0, composing: false };
    const state = { ...current.identity, ...next.appearance, ...next.model.form, privacyGeneration: next.privacy.generation,
      draftRevision: next.model.revision, acknowledgedEditRevision: edit.revision,
      canSave: next.model.canSave && !edit.composing, busy: next.model.busy, error: next.model.error } as Omit<NativeWorldModelProjection, "updateSequence">;
    const fingerprint = JSON.stringify(state); // Private volatile equality, never diagnostics.
    if (fingerprint === current.fingerprint) { current.presentation.refreshActions(actions()); return; }
    if (current.presentation.publish({ ...state, updateSequence: ++current.sequence } as NativeWorldModelProjection, actions())) current.fingerprint = fingerprint;
  }, [actions]);
  const epoch = snapshotVaultSessionEpoch(), generation = privacy?.generation, presentationBlocked = !nativeProfileSceneCanPrepare(privacy, model.form.scene, destinationId), active = privacy?.appIsActive;
  const scene = model.form.scene;
  useEffect(() => {
    if (!model.ready || generation === undefined || presentationBlocked || !active) return;
    const base = createNativeDrawerIdentity("profile");
    if (!base) return;
    const identity: NativeWorldModelIdentity = { ...base, family: "profile", scene, destinationId };
    const owner = model.owner, visit = model.id;
    let current = true;
    const isCurrent = () => current && live.current.model.ready && live.current.model.owner === owner && live.current.model.id === visit &&
      live.current.model.form.scene === scene && live.current.destinationId === destinationId && snapshotValidatedAuthSessionOwner()?.userId === owner &&
      snapshotVaultSessionEpoch() === epoch && nativeDrawerOwnerIsCurrent(identity) && live.current.privacy?.generation === generation &&
      nativeProfileSceneCanPrepare(live.current.privacy, identity.scene, identity.destinationId);
    const plugin = nativeDrawers() as ReturnType<typeof nativeDrawers> & NativeWorldModelScenePort;
    const presentation = new NativeProfileScenePresentation<NativeWorldModelProjection, NativeWorldModelEdit, NativeWorldModelAction, undefined>(identity, {
      source: plugin, apply: state => plugin.applyProfileWorldModelScene(state), confirm: event => plugin.confirmProfileWorldModelAction(event),
      settle: event => plugin.settleProfileWorldModelAction(event), retire: () => plugin.retireProfileWorldModelScene(identity),
      edits: callback => plugin.addListener("profileWorldModelEdit", callback), choices: callback => plugin.addListener("profileWorldModelAction", callback),
    }, new NativeWorldModelFence(identity), validNativeWorldModelProjection, isCurrent, phase => {
      if (!current) return;
      setPhase(phase); if (phase === "fallback") live.current.model.fallback();
    }, true, state => ({ ...state, draft: { ...state.draft } } as NativeWorldModelProjection), () => isCurrent() && nativeProfileActionsAllowed());
    const instance = { identity, presentation, sequence: 0, fingerprint: null as string | null };
    replica.current = instance; setEdit({ identity, revision: 0, composing: false });
    void presentation.listen().then(ready => { if (ready && isCurrent()) publish(); });
    return () => { current = false; if (replica.current === instance) replica.current = null; void presentation.retire(); };
  }, [model.ready, model.owner, model.id, scene, destinationId, epoch, generation, presentationBlocked, active, publish]);
  useLayoutEffect(() => { publish(); });
  useBackLayer(pathname, 100, () => {
    const current = replica.current;
    if (current && !live.current.model.busy) void current.presentation.retire().then(retired => {
      if (retired && replica.current === current && nativeDrawerOwnerIsCurrent(current.identity)) live.current.model.close();
    });
    return true;
  }, { profile_pane: "1" });
  return <div aria-busy={phase === "checking"} data-native-world-model-form={phase} />;
}
