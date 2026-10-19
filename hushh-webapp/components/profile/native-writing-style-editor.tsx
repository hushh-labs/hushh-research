"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { nativeDrawers, nativeDrawersPlatformEligible, nativeDrawerAcknowledged, hasNativeProfileScene, type HushhNativeDrawersPlugin } from "@/lib/capacitor/native-drawers";
import { createNativeDrawerIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { NativeProfileScenePresentation, type NativeProfileSceneActions } from "@/lib/capacitor/native-profile-scene-presentation";
import { NativeProfileStyleFence, STYLE_CHOICE_OPTIONS, validNativeProfileStyleProjection, type NativeProfileStyleIdentity,
  type NativeProfileStyleProjection, type NativeProfileStyleEdit, type NativeProfileStyleAction, type NativeProfileStyleScenePort } from "@/lib/capacitor/native-profile-style-scene";
import { useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { getNativeSessionPrivacyState, nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { ToneRowIcon } from "@/components/icons/agents";
import { SettingsGroup, SettingsRow } from "./settings-ui";
import { CommunicationPreferencesGroup } from "./communication-preferences-group";
import type { useCommunicationPreferencesEditor } from "./communication-preferences-section";

type Model = ReturnType<typeof useCommunicationPreferencesEditor>;
type Plugin = HushhNativeDrawersPlugin & NativeProfileStyleScenePort;
function supported(plugin: HushhNativeDrawersPlugin): plugin is Plugin {
  return hasNativeProfileScene(plugin, "writing-style");
}
export function NativeWritingStyleEditor({ model, eligible }: { model: Model; eligible: boolean }) {
  const [renderer, setRenderer] = useState<"checking" | "native" | "web">(() => eligible && nativeDrawersPlatformEligible() ? "checking" : "web");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!eligible || !nativeDrawersPlatformEligible()) return;
    let active = true;
    void nativeDrawerAcknowledged(nativeDrawers.getCapabilities()).then(value => {
      const enabled = value.contractVersion === 1 && value.supported && value.profileStyleScene === true && supported(nativeDrawers);
      if (active) setRenderer(enabled ? "native" : "web");
    }).catch(() => { if (active) setRenderer("web"); });
    return () => { active = false; };
  }, [eligible]);
  useEffect(() => { if (renderer === "native" && model.suggested) setOpen(true); }, [renderer, model.suggested]);
  if (renderer === "checking") return <div aria-busy="true" />;
  if (renderer === "web") return <CommunicationPreferencesGroup value={model.draft} onChange={model.changeDraft}
    dirty={model.dirty} saving={model.saving} loading={model.loading} unavailable={model.unavailable} suggested={model.suggested}
    onSave={() => { void model.save(); }} />;
  return <>
    <SettingsGroup title="How One writes to you">
      <SettingsRow title="Writing style" icon={ToneRowIcon} iconTone="capability" chevron onClick={() => setOpen(true)}
        disabled={!model.ready} trailing={model.suggested ? "Suggested in Chat" : model.dirty ? "Unsaved" : undefined} />
    </SettingsGroup>
    {open && supported(nativeDrawers) ? <NativeStyleSheet model={model} plugin={nativeDrawers}
      onClose={() => setOpen(false)} onFallback={() => { setOpen(false); setRenderer("web"); }} /> : null}
  </>;
}

export function NativeStyleSheet({ model, plugin, onClose, onFallback, destinationId }: {
  model: Model; plugin: Plugin; onClose: () => void; onFallback: () => void; destinationId?: string;
}) {
  const pathname = usePathname();
  const appearance = useNativeControlAppearance("secondary");
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [phase, setPhase] = useState("checking");
  const [edit, setEdit] = useState<{ identity: NativeProfileStyleIdentity | null; revision: number; composing: boolean }>({ identity: null, revision: 0, composing: false });
  const live = useRef({ model, appearance, privacy, edit, onClose, onFallback });
  useLayoutEffect(() => { live.current = { model, appearance, privacy, edit, onClose, onFallback }; });
  type Presentation = NativeProfileScenePresentation<NativeProfileStyleProjection, NativeProfileStyleEdit, NativeProfileStyleAction, undefined>;
  const replica = useRef<{ identity: NativeProfileStyleIdentity; presentation: Presentation; owner: string; sequence: number; fingerprint: string | null } | null>(null);
  const actions = useCallback((): NativeProfileSceneActions<NativeProfileStyleEdit, NativeProfileStyleAction, undefined> => ({
    edit: event => {
      live.current.model.changeField(event.field, event.value ?? undefined);
      setEdit({ identity: replica.current?.identity ?? null, revision: event.editRevision, composing: event.composing });
    },
    commit: async () => (await live.current.model.save()) === "saved" ? { kind: "saved", value: undefined } : { kind: "retained" },
    saved: () => undefined, // Save persists but does not close the existing Settings editor.
    cancel: () => live.current.onClose(),
  }), []);
  const publish = useCallback(() => {
    const current = replica.current, next = live.current;
    if (!current || !next.model.ready || next.model.userId !== current.owner || !next.appearance || !next.privacy || next.privacy.shielded || !next.privacy.appIsActive) return;
    const edit = next.edit.identity === current.identity ? next.edit : { revision: 0, composing: false };
    const state = { ...current.identity, ...next.appearance, privacyGeneration: next.privacy.generation,
      draftRevision: next.model.draftRevision, acknowledgedEditRevision: edit.revision, draft: { ...next.model.draft }, choices: STYLE_CHOICE_OPTIONS,
      canSave: next.model.dirty && !next.model.unavailable && !next.model.saving && !edit.composing, busy: next.model.saving,
      unavailable: next.model.unavailable, suggested: next.model.suggested, error: next.model.error };
    const fingerprint = JSON.stringify(state); // In-memory equality only; never diagnostics.
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
    const identity: NativeProfileStyleIdentity = { ...base, family: "profile", scene: "writing-style", ...(destinationId ? { destinationId } : {}) };
    const owner = model.userId;
    let current = true;
    const isCurrent = () => current && live.current.model.ready && live.current.model.userId === owner &&
      snapshotValidatedAuthSessionOwner()?.userId === owner && snapshotVaultSessionEpoch() === epoch && nativeDrawerOwnerIsCurrent(identity) &&
      live.current.privacy?.generation === generation && !live.current.privacy.shielded && live.current.privacy.appIsActive;
    const presentation = new NativeProfileScenePresentation<NativeProfileStyleProjection, NativeProfileStyleEdit, NativeProfileStyleAction, undefined>(identity, {
      source: plugin, apply: state => plugin.applyProfileStyleScene(state), confirm: event => plugin.confirmProfileStyleAction(event),
      settle: (event, saved) => plugin.settleProfileStyleAction({ ...event, saved }), retire: () => plugin.retireProfileStyleScene(identity),
      edits: callback => plugin.addListener("profileStyleEdit", callback), choices: callback => plugin.addListener("profileStyleAction", callback),
    }, new NativeProfileStyleFence(identity), validNativeProfileStyleProjection, isCurrent, phase => {
      if (!current) return;
      setPhase(phase);
      if (phase === "fallback") live.current.onFallback();
    }, false, state => ({ ...state, draft: { ...state.draft } }));
    const instance = { identity, presentation, owner, sequence: 0, fingerprint: null as string | null };
    replica.current = instance;
    setEdit({ identity, revision: 0, composing: false });
    void presentation.listen().then(ready => { if (ready && isCurrent()) publish(); });
    return () => { current = false; if (replica.current === instance) replica.current = null; void presentation.retire(); };
  }, [model.ready, model.userId, epoch, generation, shielded, active, plugin, publish, destinationId]);
  useLayoutEffect(() => { publish(); });
  useBackLayer(pathname, 100, () => {
    const current = replica.current;
    if (!current || live.current.model.saving) return true;
    void current.presentation.retire().then(retired => { if (retired && replica.current === current && nativeDrawerOwnerIsCurrent(current.identity)) live.current.onClose(); });
    return true;
  }, destinationId ? { profile_pane: "1" } : undefined);
  return <div aria-busy={phase === "checking"} data-native-profile-style-state={phase} />;
}
