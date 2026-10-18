"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import type { PluginListenerHandle } from "@capacitor/core";
import type { CustomConnectorSettingsModel } from "@/components/agent/custom-connectors-settings";
import { nativeDrawers, nativeDrawerAcknowledged } from "@/lib/capacitor/native-drawers";
import { createNativeDrawerIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { NativeProfileScenePresentation } from "@/lib/capacitor/native-profile-scene-presentation";
import { NativeConnectorFence, validNativeConnectorProjection, validNativeConnectorFinalEdit, type NativeConnectorIdentity, type NativeConnectorProjection,
  type NativeConnectorEdit, type NativeConnectorAction, type NativeConnectorScenePort } from "@/lib/capacitor/native-profile-connector-scene";
import { useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

type Presentation = NativeProfileScenePresentation<NativeConnectorProjection, NativeConnectorEdit, NativeConnectorAction, undefined>;
/** No secret persistence, provider call or second validation owner. */
export function NativeConnectorEditor({ model, owner, destinationId, onClose, onFallback }: {
  model: CustomConnectorSettingsModel; owner: string; destinationId: string; onClose: () => void; onFallback: () => void;
}) {
  const pathname = usePathname(), appearance = useNativeControlAppearance("secondary");
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [phase, setPhase] = useState("checking");
  const [edit, setEdit] = useState<{ identity: NativeConnectorIdentity | null; revision: number; composing: boolean }>({ identity: null, revision: 0, composing: false });
  const live = useRef({ model, appearance, privacy, edit, destinationId, owner, onClose, onFallback });
  useLayoutEffect(() => { live.current = { model, appearance, privacy, edit, destinationId, owner, onClose, onFallback }; });
  const replica = useRef<{ identity: NativeConnectorIdentity; presentation: Presentation; sequence: number; fingerprint: string | null;
    finalInput: { nativeRevision: number; modelRevision: number; discard: boolean } } | null>(null);
  const actions = useCallback(() => ({
    edit: (event: NativeConnectorEdit) => {
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
    saved: () => live.current.onClose(), cancel: () => live.current.onClose(),
  }), []);
  const publish = useCallback(() => {
    const current = replica.current, v = live.current, m = v.model;
    if (!current || !v.appearance || !m.current() || !v.privacy || v.privacy.shielded || !v.privacy.appIsActive) return;
    const edit = v.edit.identity === current.identity ? v.edit : { revision: 0, composing: false };
    const draft = { ...m.draft };
    const value = { ...current.identity, ...v.appearance, draft, draftRevision: m.inputRevision(), acknowledgedEditRevision: edit.revision, privacyGeneration: v.privacy.generation,
      canSave: !edit.composing && !!draft.name.trim() && !!draft.endpoint.trim(), busy: m.busy, error: m.error };
    const fingerprint = JSON.stringify(value); // Private memory only; never telemetry.
    if (fingerprint === current.fingerprint) { current.presentation.refreshActions(actions()); return; }
    if (current.presentation.publish({ ...value, updateSequence: ++current.sequence }, actions())) current.fingerprint = fingerprint;
  }, [actions]);
  const epoch = snapshotVaultSessionEpoch(), generation = privacy?.generation, shielded = privacy?.shielded, active = privacy?.appIsActive;
  const controller = model.current;
  useEffect(() => {
    if (generation === undefined || shielded || !active) return;
    const base = createNativeDrawerIdentity("profile"); if (!base) return;
    const identity: NativeConnectorIdentity = { ...base, family: "profile", scene: "connector-custom-server", destinationId };
    let current = true;
    const isCurrent = () => current && live.current.model.current === controller && controller() && live.current.owner === owner && live.current.destinationId === destinationId &&
      snapshotVaultSessionEpoch() === epoch && nativeDrawerOwnerIsCurrent(identity) && live.current.privacy?.generation === generation &&
      !live.current.privacy.shielded && live.current.privacy.appIsActive;
    const port = nativeDrawers as typeof nativeDrawers & NativeConnectorScenePort;
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
    const presentation = new NativeProfileScenePresentation<NativeConnectorProjection, NativeConnectorEdit, NativeConnectorAction, undefined>(identity, {
      source: port, apply: state => port.applyProfileConnectorScene(state), confirm: async action => {
        const result = await port.confirmProfileConnectorAction(action);
        if (result.valid && action.action === "cancel" && isCurrent()) finalInput.discard = true;
        return result;
      },
      settle: action => port.settleProfileConnectorAction(action), retire: () => port.retireProfileConnectorScene(identity),
      edits: callback => port.addListener("profileConnectorEdit", callback), choices: callback => port.addListener("profileConnectorAction", callback),
    }, new NativeConnectorFence(identity), validNativeConnectorProjection, isCurrent, phase => {
      if (current) { setPhase(phase); if (phase === "fallback") live.current.onFallback(); }
    }, true, state => ({ ...state, draft: { ...state.draft } }));
    const instance = { identity, presentation, sequence: 0, fingerprint: null as string | null, finalInput };
    replica.current = instance; setEdit({ identity, revision: 0, composing: false });
    const finalPending = port.addListener("profileConnectorFinalEdit", event => {
      const m = live.current.model;
      // Privacy can revoke interaction before UIKit commits its last marked
      // text. Reconcile only that original private draft, never an operation.
      if (!acceptFinalInput || finalInput.discard || m.current !== controller || !controller() || live.current.owner !== owner ||
          snapshotVaultSessionEpoch() !== epoch || !nativeDrawerOwnerIsCurrent(identity) || !validNativeConnectorFinalEdit(event, identity) ||
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
  }, [owner, controller, destinationId, epoch, generation, shielded, active, publish]);
  useLayoutEffect(() => { publish(); });
  useBackLayer(pathname, 100, () => {
    const current = replica.current;
    if (current && !live.current.model.mutationPending()) { current.finalInput.discard = true; void current.presentation.retire().then(retired => {
      if (retired && replica.current === current && nativeDrawerOwnerIsCurrent(current.identity)) live.current.onClose();
    }); }
    return true;
  }, { profile_pane: "1" });
  return <div aria-busy={phase === "checking"} data-native-connector-editor={phase} />;
}
