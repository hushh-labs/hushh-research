"use client";

import { nativeProfileSceneCanPrepare, nativeProfileActionsAllowed } from "@/lib/capacitor/native-profile-preparation";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import type { PluginListenerHandle } from "@capacitor/core";
import type { GeminiRuntimeSettingsModel } from "@/components/connections/gemini-runtime-settings-card";
import { nativeDrawers, nativeDrawerAcknowledged } from "@/lib/capacitor/native-drawers";
import { createNativeDrawerIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { NativeProfileScenePresentation } from "@/lib/capacitor/native-profile-scene-presentation";
import { NativeRuntimeFence, validNativeRuntimeProjection, validNativeRuntimeFinalEdit, type NativeRuntimeIdentity, type NativeRuntimeProjection,
  type NativeRuntimeEdit, type NativeRuntimeAction, type NativeRuntimeScenePort } from "@/lib/capacitor/native-profile-runtime-scene";
import { useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

type Presentation = NativeProfileScenePresentation<NativeRuntimeProjection, NativeRuntimeEdit, NativeRuntimeAction, undefined>;
/** No secret persistence, provider call or second validation owner. */
export function NativeRuntimeEditor({ model, owner, destinationId, onClose, onFallback }: {
  model: GeminiRuntimeSettingsModel; owner: string; destinationId: string; onClose: () => void; onFallback: () => void;
}) {
  const pathname = usePathname(), appearance = useNativeControlAppearance("secondary");
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [phase, setPhase] = useState("checking");
  const [edit, setEdit] = useState<{ identity: NativeRuntimeIdentity | null; revision: number; composing: boolean }>({ identity: null, revision: 0, composing: false });
  const live = useRef({ model, appearance, privacy, edit, destinationId, owner, onClose, onFallback });
  useLayoutEffect(() => { live.current = { model, appearance, privacy, edit, destinationId, owner, onClose, onFallback }; });
  const replica = useRef<{ identity: NativeRuntimeIdentity; presentation: Presentation; sequence: number; fingerprint: string | null;
    finalInput: { nativeRevision: number; modelRevision: number; discard: boolean } } | null>(null);
  const actions = useCallback(() => ({
    edit: (event: NativeRuntimeEdit) => {
      const m = live.current.model;
      m.setDraftKey(event.draft.credential); m.setTransport(event.draft.transport); m.setVertexProject(event.draft.project); m.setVertexLocation(event.draft.location);
      if (replica.current) { replica.current.finalInput.nativeRevision = event.editRevision; replica.current.finalInput.modelRevision = m.inputRevision(); }
      setEdit({ identity: replica.current?.identity ?? null, revision: event.editRevision, composing: event.composing });
    },
    commit: async () => {
      const m = live.current.model;
      const installation = replica.current;
      if (m.credentialValidation.status !== "ready") { await m.validateByok(); return { kind: "retained" as const }; }
      const saved = await m.saveByok();
      if (saved && installation) installation.finalInput.discard = true;
      return saved ? { kind: "saved" as const, value: undefined } : { kind: "retained" as const };
    },
    saved: () => live.current.onClose(), cancel: () => live.current.onClose(),
  }), []);
  const publish = useCallback(() => {
    const current = replica.current, v = live.current, m = v.model;
    if (!current || !v.appearance || !m.current() || !v.privacy || !nativeProfileSceneCanPrepare(v.privacy, current.identity.scene, current.identity.destinationId)) return;
    const edit = v.edit.identity === current.identity ? v.edit : { revision: 0, composing: false };
    const draft = { credential: m.draftKey, transport: m.transport, project: m.vertexProject, location: m.vertexLocation };
    const value = { ...current.identity, ...v.appearance, draft, draftRevision: m.inputRevision(), acknowledgedEditRevision: edit.revision, privacyGeneration: v.privacy.generation,
      canSave: !edit.composing && m.credentialValidation.status !== "checking" && !!draft.credential.trim() && (draft.transport !== "vertex_api_key" || !!draft.project.trim() && !!draft.location.trim()),
      busy: m.isSaving || m.isRemoving, checking: m.credentialValidation.status === "checking",
      primary: m.credentialValidation.status === "ready" ? "save" as const : "validate" as const,
      error: m.credentialValidation.status === "error" ? m.credentialValidation.message : null };
    const fingerprint = JSON.stringify(value); // Private memory only; never telemetry.
    if (fingerprint === current.fingerprint) { current.presentation.refreshActions(actions()); return; }
    if (current.presentation.publish({ ...value, updateSequence: ++current.sequence }, actions())) current.fingerprint = fingerprint;
  }, [actions]);
  const epoch = snapshotVaultSessionEpoch(), generation = privacy?.generation, presentationBlocked = !nativeProfileSceneCanPrepare(privacy, "runtime-provider", destinationId), active = privacy?.appIsActive;
  const controller = model.current;
  useEffect(() => {
    if (generation === undefined || presentationBlocked || !active) return;
    const base = createNativeDrawerIdentity("profile"); if (!base) return;
    const identity: NativeRuntimeIdentity = { ...base, family: "profile", scene: "runtime-provider", destinationId };
    let current = true;
    const isCurrent = () => current && live.current.model.current === controller && controller() && live.current.owner === owner && live.current.destinationId === destinationId &&
      snapshotVaultSessionEpoch() === epoch && nativeDrawerOwnerIsCurrent(identity) && live.current.privacy?.generation === generation &&
      nativeProfileSceneCanPrepare(live.current.privacy, identity.scene, identity.destinationId);
    const port = nativeDrawers() as ReturnType<typeof nativeDrawers> & NativeRuntimeScenePort;
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
    const presentation = new NativeProfileScenePresentation<NativeRuntimeProjection, NativeRuntimeEdit, NativeRuntimeAction, undefined>(identity, {
      source: port, apply: state => port.applyProfileRuntimeScene(state), confirm: async action => {
        const result = await port.confirmProfileRuntimeAction(action);
        if (result.valid && action.action === "cancel" && isCurrent()) finalInput.discard = true;
        return result;
      },
      settle: action => port.settleProfileRuntimeAction(action), retire: () => port.retireProfileRuntimeScene(identity),
      edits: callback => port.addListener("profileRuntimeEdit", callback), choices: callback => port.addListener("profileRuntimeAction", callback),
    }, new NativeRuntimeFence(identity), validNativeRuntimeProjection, isCurrent, phase => {
      if (current) { setPhase(phase); if (phase === "fallback") live.current.onFallback(); }
    }, true, state => ({ ...state, draft: { ...state.draft } }), () => isCurrent() && nativeProfileActionsAllowed());
    const instance = { identity, presentation, sequence: 0, fingerprint: null as string | null, finalInput };
    replica.current = instance; setEdit({ identity, revision: 0, composing: false });
    const finalPending = port.addListener("profileRuntimeFinalEdit", event => {
      const m = live.current.model;
      // Privacy can revoke interaction before UIKit commits its last marked
      // text. Reconcile only that original private draft, never an operation.
      if (!acceptFinalInput || finalInput.discard || m.current !== controller || !controller() || live.current.owner !== owner ||
          snapshotVaultSessionEpoch() !== epoch || !nativeDrawerOwnerIsCurrent(identity) || !validNativeRuntimeFinalEdit(event, identity) ||
          event.privacyGeneration !== generation || event.editRevision <= finalInput.nativeRevision) return;
      const revision = m.inputRevision();
      if (revision === event.baseDraftRevision || revision === finalInput.modelRevision) {
        if (m.reconcileFinalDraft(event.draft, revision)) { finalInput.nativeRevision = event.editRevision; finalInput.modelRevision = m.inputRevision(); }
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
  }, [owner, controller, destinationId, epoch, generation, presentationBlocked, active, publish]);
  useLayoutEffect(() => { publish(); });
  useBackLayer(pathname, 100, () => {
    const current = replica.current;
    if (current && !live.current.model.mutationPending()) { current.finalInput.discard = true; void current.presentation.retire().then(retired => {
      if (retired && replica.current === current && nativeDrawerOwnerIsCurrent(current.identity)) live.current.onClose();
    }); }
    return true;
  }, { profile_pane: "1" });
  return <div aria-busy={phase === "checking"} data-native-runtime-editor={phase} />;
}
