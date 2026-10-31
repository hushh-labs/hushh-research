"use client";

import { nativeProfileSceneCanPrepare, nativeProfileActionsAllowed } from "@/lib/capacitor/native-profile-preparation";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import type { PluginListenerHandle } from "@capacitor/core";
import { nativeDrawerAcknowledged } from "@/lib/capacitor/native-drawers";
import { createNativeDrawerIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { NativeProfileScenePresentation } from "@/lib/capacitor/native-profile-scene-presentation";
import type { PrivateProfileIdentity, PrivateProfileProjection, PrivateProfileEdit, PrivateProfileAction, PrivateProfileEditorAdapter, PrivateProfileEditorModel } from "@/lib/capacitor/native-profile-private-editor";
import { useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

/** Retained private editor mechanics; no feature schema or operation is inferred. */
export function NativePrivateProfileForm<D extends object, S extends string>({ model, scene, adapter, owner, destinationId, onClose, onSaved, onFallback }: {
  model: PrivateProfileEditorModel<D>; scene: S; adapter: PrivateProfileEditorAdapter<D, S>;
  owner: string; destinationId: string; onClose: () => void; onSaved?: () => void; onFallback: () => void;
}) {
  type Identity = PrivateProfileIdentity<S>;
  type Projection = PrivateProfileProjection<D, S>;
  type Edit = PrivateProfileEdit<D, S>;
  type Action = PrivateProfileAction<S>;
  type Presentation = NativeProfileScenePresentation<Projection, Edit, Action, undefined>;
  const pathname = usePathname(), appearance = useNativeControlAppearance("secondary");
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [phase, setPhase] = useState("checking");
  const [edit, setEdit] = useState<{ identity: Identity | null; revision: number; composing: boolean }>({ identity: null, revision: 0, composing: false });
  const live = useRef({ model, appearance, privacy, edit, destinationId, owner, onClose, onSaved, onFallback });
  useLayoutEffect(() => { live.current = { model, appearance, privacy, edit, destinationId, owner, onClose, onSaved, onFallback }; });
  const replica = useRef<{ identity: Identity; presentation: Presentation; sequence: number; fingerprint: string | null;
    finalInput: { nativeRevision: number; modelRevision: number; discard: boolean } } | null>(null);
  const actions = useCallback(() => ({
    edit: (event: Edit) => {
      const m = live.current.model;
      if (!m.changeDraft(event.draft)) {
        // Do not acknowledge a value that the authoritative editor refused.
        // Withdraw this replica without replaying a save or reviving actions.
        const instance = replica.current;
        setPhase("blocked");
        if (instance) void instance.presentation.retire().then(retired => {
          if (retired && replica.current === instance && nativeDrawerOwnerIsCurrent(instance.identity) && live.current.model.current()) live.current.onFallback();
        });
        return;
      }
      if (replica.current) { replica.current.finalInput.nativeRevision = event.editRevision; replica.current.finalInput.modelRevision = m.inputRevision(); }
      setEdit({ identity: replica.current?.identity ?? null, revision: event.editRevision, composing: event.composing });
    },
    commit: async () => {
      const m = live.current.model;
      const installation = replica.current;
      const saved = await m.save();
      if (saved && installation) installation.finalInput.discard = true;
      return saved ? { kind: "saved" as const, value: undefined } : { kind: "retained" as const };
    },
    saved: () => (live.current.onSaved ?? live.current.onClose)(), cancel: () => live.current.onClose(),
  }), []);
  const publish = useCallback(() => {
    const current = replica.current, v = live.current, m = v.model;
    if (!current || !v.appearance || !m.current() || !v.privacy || !nativeProfileSceneCanPrepare(v.privacy, current.identity.scene, current.identity.destinationId)) return;
    const edit = v.edit.identity === current.identity ? v.edit : { revision: 0, composing: false };
    const draft = { ...m.draft };
    const value = { ...current.identity, ...v.appearance, draft, draftRevision: m.inputRevision(), acknowledgedEditRevision: edit.revision, privacyGeneration: v.privacy.generation,
      canSave: !edit.composing && m.canSave, busy: m.busy, error: m.error };
    const fingerprint = JSON.stringify(value); // Private memory only; never telemetry.
    if (fingerprint === current.fingerprint) { current.presentation.refreshActions(actions()); return; }
    if (current.presentation.publish({ ...value, updateSequence: ++current.sequence }, actions())) current.fingerprint = fingerprint;
  }, [actions]);
  const epoch = snapshotVaultSessionEpoch(), generation = privacy?.generation, presentationBlocked = !nativeProfileSceneCanPrepare(privacy, scene, destinationId), active = privacy?.appIsActive;
  const controller = model.current;
  useEffect(() => {
    if (generation === undefined || presentationBlocked || !active) return;
    const base = createNativeDrawerIdentity("profile"); if (!base) return;
    const identity: Identity = { ...base, family: "profile", scene, destinationId };
    let current = true;
    const isCurrent = () => current && live.current.model.current === controller && controller() && live.current.owner === owner && live.current.destinationId === destinationId &&
      snapshotVaultSessionEpoch() === epoch && nativeDrawerOwnerIsCurrent(identity) && live.current.privacy?.generation === generation &&
      nativeProfileSceneCanPrepare(live.current.privacy, identity.scene, identity.destinationId);
    const { port, finalEdits } = adapter.connect(identity);
    const finalInput = { nativeRevision: 0, modelRevision: live.current.model.inputRevision(), discard: false };
    let acceptFinalInput = true, finalHandle: PluginListenerHandle | undefined;
    let stopEpoch = () => {}, stopPrivacy = () => {};
    const draftOwnerIsCurrent = () => live.current.model.current === controller && controller() && live.current.owner === owner &&
      snapshotVaultSessionEpoch() === epoch && nativeDrawerOwnerIsCurrent(identity);
    const releaseFinalInput = () => {
      if (!acceptFinalInput) return;
      acceptFinalInput = false; void finalHandle?.remove().catch(() => undefined);
      stopEpoch(); stopPrivacy(); window.removeEventListener("pagehide", releaseFinalInput);
    };
    const checkRetainedOwner = () => { if (!draftOwnerIsCurrent()) releaseFinalInput(); };
    stopEpoch = subscribeVaultSessionEpoch(checkRetainedOwner);
    stopPrivacy = subscribeNativePrivacyObservation(checkRetainedOwner);
    window.addEventListener("pagehide", releaseFinalInput);
    const finishRetirement = (retired: boolean) => {
      // Uncertainty does not prove withdrawal. Keep only the original draft's
      // readback receiver until its final input or owner retirement; no action
      // receiver or operation may survive the presentation's own retirement.
      if (retired || finalInput.discard || !draftOwnerIsCurrent()) releaseFinalInput();
    };
    const presentation = new NativeProfileScenePresentation<Projection, Edit, Action, undefined>(identity, { ...port, confirm: async action => {
        const result = await port.confirm(action);
        if (result.valid && action.action === "cancel" && isCurrent()) finalInput.discard = true;
        return result;
      },
    }, adapter.fence(identity), adapter.valid, isCurrent, phase => {
      if (current) { setPhase(phase); if (phase === "fallback") live.current.onFallback(); }
    }, true, state => ({ ...state, draft: { ...state.draft } }), () => isCurrent() && nativeProfileActionsAllowed());
    const instance = { identity, presentation, sequence: 0, fingerprint: null as string | null, finalInput };
    replica.current = instance; setEdit({ identity, revision: 0, composing: false });
    const finalPending = finalEdits(event => {
      const m = live.current.model;
      // Privacy can revoke interaction before UIKit commits its last marked
      // text. Reconcile only that original private draft, never an operation.
      if (!acceptFinalInput || finalInput.discard || m.current !== controller || !controller() || live.current.owner !== owner ||
          snapshotVaultSessionEpoch() !== epoch || !nativeDrawerOwnerIsCurrent(identity) || !adapter.validFinal(event, identity) ||
          event.privacyGeneration !== generation || event.editRevision <= finalInput.nativeRevision) return;
      const revision = m.inputRevision();
      if (revision === event.baseDraftRevision || revision === finalInput.modelRevision) {
        if (m.changeDraft(event.draft, revision)) { finalInput.nativeRevision = event.editRevision; finalInput.modelRevision = m.inputRevision(); }
      }
      releaseFinalInput(); // Native emits this only while clearing this model.
    });
    void finalPending.then(handle => { if (!acceptFinalInput) void handle.remove().catch(() => undefined); }).catch(() => undefined);
    const finalReady = nativeDrawerAcknowledged(finalPending).then(handle => { finalHandle = handle; if (!acceptFinalInput) void handle.remove().catch(() => undefined); });
    void finalReady.then(() => presentation.listen()).then(ready => { if (ready && isCurrent()) publish(); }).catch(() => {
      void presentation.retire().then(retired => { finishRetirement(retired); if (retired && isCurrent()) live.current.onFallback(); });
    });
    return () => {
      current = false; instance.fingerprint = null; if (replica.current === instance) replica.current = null;
      void presentation.retire().then(finishRetirement);
    };
  }, [adapter, owner, controller, scene, destinationId, epoch, generation, presentationBlocked, active, publish]);
  useLayoutEffect(() => { publish(); });
  useBackLayer(pathname, 100, () => {
    const current = replica.current;
    if (current && !live.current.model.mutationPending()) { current.finalInput.discard = true; void current.presentation.retire().then(retired => {
      if (retired && replica.current === current && nativeDrawerOwnerIsCurrent(current.identity)) live.current.onClose();
    }); }
    return true;
  }, { profile_pane: "1" });
  return <div aria-busy={phase === "checking"} data-native-private-profile-editor={phase} />;
}
