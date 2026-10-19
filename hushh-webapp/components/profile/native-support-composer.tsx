"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { nativeDrawers, nativeDrawerAcknowledged, type HushhNativeDrawersPlugin } from "@/lib/capacitor/native-drawers";
import { createNativeDrawerIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { NativeProfileScenePresentation, type NativeProfileSceneActions } from "@/lib/capacitor/native-profile-scene-presentation";
import { NativeSupportFence, validNativeSupportProjection, type NativeSupportIdentity, type NativeSupportDraft,
  type NativeSupportProjection, type NativeSupportEdit, type NativeSupportAction, type NativeSupportScenePort } from "@/lib/capacitor/native-profile-support-scene";
import { getNativeSessionPrivacyState, nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useBackLayer } from "@/lib/navigation/back-layers";
import type { SupportSubmitOutcome } from "@/lib/profile/profile-action-outcomes";

export type NativeSupportComposerModel = {
  userId: string; ready: boolean; draft: NativeSupportDraft; busy: boolean; sent: boolean; error: string | null;
  replyLine: string; placeholder: string; submitLabel: string; successTitle: string; successDescription: string;
  change: (draft: NativeSupportDraft) => void; send: () => Promise<SupportSubmitOutcome>; close: () => void;
};
type Plugin = HushhNativeDrawersPlugin & NativeSupportScenePort;

/** A presentation replica only. The existing Profile composer remains the
 * single draft and delivery owner for web, voice and this native adapter. */
export function NativeSupportComposer({ model, destinationId, onFallback }: {
  model: NativeSupportComposerModel; destinationId: string; onFallback: () => void;
}) {
  const plugin = nativeDrawers as Plugin; // Admitted by the parent's capability/method check.
  const pathname = usePathname();
  const appearance = useNativeControlAppearance("secondary");
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [phase, setPhase] = useState("checking");
  const [, acknowledgeEdit] = useState(0);
  const live = useRef({ model, appearance, privacy, onFallback });
  useLayoutEffect(() => { live.current = { model, appearance, privacy, onFallback }; });
  type Presentation = NativeProfileScenePresentation<NativeSupportProjection, NativeSupportEdit, NativeSupportAction, undefined>;
  const replica = useRef<{ identity: NativeSupportIdentity; owner: string; presentation: Presentation; sequence: number;
    editRevision: number; composing: boolean; fingerprint: string | null } | null>(null);
  const actions = useCallback((): NativeProfileSceneActions<NativeSupportEdit, NativeSupportAction, undefined> => ({
    edit: event => {
      const current = replica.current;
      if (!current) return;
      current.editRevision = event.editRevision; current.composing = event.composing;
      live.current.model.change({ ...event.draft });
      acknowledgeEdit(event.editRevision);
    },
    commit: async () => (await live.current.model.send()).kind === "accepted" ? { kind: "saved", value: undefined } : { kind: "retained" },
    saved: () => undefined, // Provider acceptance stays visible until the owner's explicit Done.
    cancel: () => live.current.model.close(),
  }), []);
  const publish = useCallback(() => {
    const current = replica.current, next = live.current;
    if (!current || !next.model.ready || next.model.userId !== current.owner || !next.appearance || !next.privacy || next.privacy.shielded || !next.privacy.appIsActive) return;
    const { model } = next;
    const state = { ...current.identity, ...next.appearance, privacyGeneration: next.privacy.generation,
      draftRevision: current.sequence + 1, acknowledgedEditRevision: current.editRevision, draft: { ...model.draft },
      canSave: !model.busy && !model.sent && !current.composing && model.draft.message.trim().length >= 10 && model.draft.message.length <= 8000,
      busy: model.busy, sent: model.sent, error: model.error, replyLine: model.replyLine, placeholder: model.placeholder,
      submitLabel: model.submitLabel, successTitle: model.successTitle, successDescription: model.successDescription };
    const fingerprint = JSON.stringify({ ...state, draftRevision: 0 }); // Memory-only equality; never diagnostics.
    if (fingerprint === current.fingerprint) { current.presentation.refreshActions(actions()); return; }
    if (current.presentation.publish({ ...state, updateSequence: ++current.sequence }, actions())) current.fingerprint = fingerprint;
  }, [actions]);
  useEffect(() => { if (!nativePrivacyObservation().state) void nativeDrawerAcknowledged(getNativeSessionPrivacyState()).catch(() => setPhase("blocked")); }, []);
  const epoch = snapshotVaultSessionEpoch();
  const generation = privacy?.generation, shielded = privacy?.shielded, active = privacy?.appIsActive;
  useEffect(() => {
    if (!model.ready || !model.userId || generation === undefined || shielded || !active) return;
    const base = createNativeDrawerIdentity("profile");
    if (!base) return;
    const identity: NativeSupportIdentity = { ...base, family: "profile", scene: "support", destinationId };
    const owner = model.userId;
    let current = true;
    const isCurrent = () => current && live.current.model.ready && live.current.model.userId === owner &&
      snapshotValidatedAuthSessionOwner()?.userId === owner && snapshotVaultSessionEpoch() === epoch && nativeDrawerOwnerIsCurrent(identity) &&
      live.current.privacy?.generation === generation && !live.current.privacy.shielded && live.current.privacy.appIsActive;
    const presentation = new NativeProfileScenePresentation<NativeSupportProjection, NativeSupportEdit, NativeSupportAction, undefined>(identity, {
      source: plugin, apply: state => plugin.applyProfileSupportScene(state), confirm: event => plugin.confirmProfileSupportAction(event),
      settle: (event, saved) => plugin.settleProfileSupportAction({ ...event, saved }), retire: () => plugin.retireProfileSupportScene(identity),
      edits: callback => plugin.addListener("profileSupportEdit", callback), choices: callback => plugin.addListener("profileSupportAction", callback),
    }, new NativeSupportFence(identity), validNativeSupportProjection, isCurrent, phase => {
      if (!current) return;
      setPhase(phase);
      if (phase === "fallback") live.current.onFallback();
    }, false, state => ({ ...state, draft: { ...state.draft } }));
    replica.current = { identity, owner, presentation, sequence: 0, editRevision: 0, composing: false, fingerprint: null };
    void presentation.listen().then(ready => { if (ready && isCurrent()) publish(); });
    return () => { current = false; if (replica.current?.identity === identity) replica.current = null; void presentation.retire(); };
  }, [model.ready, model.userId, destinationId, epoch, generation, shielded, active, plugin, actions, publish]);
  useLayoutEffect(() => { publish(); });
  useBackLayer(pathname, 100, () => {
    const current = replica.current;
    if (!current || live.current.model.busy) return true;
    void current.presentation.retire().then(retired => {
      if (retired && replica.current === current && nativeDrawerOwnerIsCurrent(current.identity)) live.current.model.close();
    });
    return true;
  }, { profile_pane: "1" });
  return <div aria-busy={phase === "checking"} data-native-profile-support-state={phase} />;
}
