"use client";

import { nativeProfileSceneCanPrepare, nativeProfileActionsAllowed } from "@/lib/capacitor/native-profile-preparation";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import type { AccountIdentity } from "@/lib/services/api-service";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { nativeDrawers, nativeDrawersPlatformEligible, nativeDrawerAcknowledged } from "@/lib/capacitor/native-drawers";
import { createNativeDrawerIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { NativeProfileNamePresentation, hasNativeProfileNameScene, type NativeProfileNameActions } from "@/lib/capacitor/native-profile-name-presentation";
import type { NativeProfileNameIdentity, NativeProfileNameProjection } from "@/lib/capacitor/native-profile-name-scene";
import { useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { getNativeSessionPrivacyState, nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { DisplayNameEditorForm, useDisplayNameEditor, type DisplayNameEditorProps } from "./display-name-editor";

/** Complete optional form scene, not a native replacement for each DOM field.
 * Only iPhone qualification binaries advertise it. Other renderers keep the
 * same feature controller and established web form from its first reveal. */
export function NativeDisplayNameEditor(props: DisplayNameEditorProps & {
  destinationId?: string;
  portalFallback?: boolean;
  webHost?: HTMLElement | null;
  onWebFallback?: () => void;
}) {
  // Native completion closes only after UIKit proves dismissal. The same
  // feature still validates and performs the one authenticated account write.
  const webCompletion = useRef(false);
  const model = useDisplayNameEditor({ ...props, onSaved: identity => {
    if (webCompletion.current) props.onSaved?.(identity);
  } });
  return <NativeProfileTextEditor<AccountIdentity> {...props} scene="account-name" model={model}
    save={async () => {
      const result = await model.submit();
      return result.kind === "saved" ? { kind: "saved", value: result.identity } : { kind: "retained" };
    }} onRenderer={phase => { webCompletion.current = phase === "web"; }}
    fallback={<DisplayNameEditorForm model={model} className={props.className} onCancel={props.onCancel} />} />;
}

/** One bounded ordinary-text editor family. The scene chooses presentation,
 * never validation or a writer: each caller supplies its existing operation. */
export function NativeProfileTextEditor<T>(props: {
  scene: NativeProfileNameIdentity["scene"];
  model: Pick<ReturnType<typeof useDisplayNameEditor>, "ready" | "uid" | "draft" | "draftRevision" | "canSave" | "saving" | "inlineError" | "changeDraft">;
  destinationId?: string; portalFallback?: boolean; webHost?: HTMLElement | null;
  onWebFallback?: () => void; onSaved?: (value: T) => void; onCancel?: () => void;
  onRenderer?: (phase: string) => void; fallback?: ReactNode;
  save: NativeProfileNameActions<T>["save"];
}) {
  const { model } = props;
  const pathname = usePathname();
  const appearance = useNativeControlAppearance("secondary");
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation,
    () => nativePrivacyObservation().state, () => undefined);
  const [renderer, setRenderer] = useState<"checking" | "native" | "web" | "blocked">(() => nativeDrawersPlatformEligible() ? "checking" : "web");
  const [admitted, setAdmitted] = useState(false);
  const [edit, setEdit] = useState<{ identity: NativeProfileNameIdentity | null; revision: number; composing: boolean }>({ identity: null, revision: 0, composing: false });
  const live = useRef({ model, props, appearance, privacy, edit });
  useLayoutEffect(() => {
    props.onRenderer?.(renderer);
    live.current = { model, props, appearance, privacy, edit };
  });
  useEffect(() => { if (renderer === "web") live.current.props.onWebFallback?.(); }, [renderer]);
  const replica = useRef<{ owner: string; epoch: number; identity: NativeProfileNameIdentity;
    presentation: NativeProfileNamePresentation<T>; sequence: number; fingerprint: string | null } | null>(null);
  const closing = useRef(false);

  const actions = useCallback((): NativeProfileNameActions<T> => ({
    edit: (text, composing, revision) => {
      live.current.model.changeDraft(text);
      setEdit({ identity: replica.current?.identity ?? null, revision, composing });
    },
    save: async () => {
      return live.current.props.save();
    },
    saved: value => live.current.props.onSaved?.(value),
    cancel: () => live.current.props.onCancel?.(),
  }), []);
  const publish = useCallback(() => {
    const current = replica.current;
    const next = live.current;
    if (!current || !next.appearance || !next.model.ready || next.model.uid !== current.owner ||
        !next.privacy || !nativeProfileSceneCanPrepare(next.privacy, current.identity.scene, current.identity.destinationId)) return;
    // A newly admitted scene starts at native edit revision zero. A render
    // from the retiring scene must not acknowledge edits in its replacement.
    const edit = next.edit.identity === current.identity ? next.edit : { revision: 0, composing: false };
    const value = { ...current.identity, ...next.appearance, privacyGeneration: next.privacy.generation,
      draftRevision: next.model.draftRevision, acknowledgedEditRevision: edit.revision,
      draft: next.model.draft, canSave: next.model.canSave && !edit.composing, busy: next.model.saving,
      error: next.model.inlineError };
    const fingerprint = JSON.stringify(value); // Volatile equality only; never diagnostics.
    if (fingerprint === current.fingerprint) { current.presentation.refreshActions(actions()); return; }
    const projection: NativeProfileNameProjection = { ...value, updateSequence: ++current.sequence };
    if (current.presentation.publish(projection, actions())) current.fingerprint = fingerprint;
  }, [actions]);
  useEffect(() => {
    if (!nativeDrawersPlatformEligible()) return;
    let active = true;
    void nativeDrawerAcknowledged(nativeDrawers().getCapabilities()).then(value => {
      const supported = value.contractVersion === 1 && value.supported && value.profileNameScene === true &&
        (props.scene !== "referral-handle" || value.profileReferralPages === true) && hasNativeProfileNameScene(nativeDrawers());
      if (active) { setAdmitted(supported); if (!supported) setRenderer("web"); }
    }).catch(() => { if (active) setRenderer("web"); }); // No native apply was attempted.
    if (!nativePrivacyObservation().state) void nativeDrawerAcknowledged(getNativeSessionPrivacyState())
      .catch(() => { if (active) setRenderer("blocked"); });
    return () => { active = false; };
  }, [props.scene]);

  const epoch = snapshotVaultSessionEpoch();
  const privacyGeneration = privacy?.generation;
  const presentationBlocked = !nativeProfileSceneCanPrepare(privacy, props.scene, props.destinationId);
  const privacyActive = privacy?.appIsActive;
  useEffect(() => {
    if (!admitted || !model.uid || !model.ready || privacyGeneration === undefined || presentationBlocked || !privacyActive) return;
    const plugin = nativeDrawers();
    if (!hasNativeProfileNameScene(plugin)) return;
    const base = createNativeDrawerIdentity("profile");
    if (!base) return;
    const identity: NativeProfileNameIdentity = { ...base, family: "profile", scene: props.scene,
      ...(props.destinationId ? { destinationId: props.destinationId } : {}) };
    const owner = model.uid;
    const generation = privacyGeneration;
    let active = true;
    const isCurrent = () => active && live.current.model.ready && live.current.model.uid === owner &&
      snapshotValidatedAuthSessionOwner()?.userId === owner && snapshotVaultSessionEpoch() === epoch && nativeDrawerOwnerIsCurrent(identity) &&
      live.current.props.destinationId === identity.destinationId &&
      live.current.privacy?.generation === generation && nativeProfileSceneCanPrepare(live.current.privacy, identity.scene, identity.destinationId);
    const presentation = new NativeProfileNamePresentation<T>(identity, plugin, isCurrent, phase => {
      if (!active) return;
      // A confirmed fallback is the renderer for this editor lifetime. An
      // ordinary privacy resume must not swap it back to native mid-edit.
      if (phase === "fallback") setAdmitted(false);
      setRenderer(phase === "active" ? "native" : phase === "fallback" ? "web" : "blocked");
    }, () => isCurrent() && nativeProfileActionsAllowed());
    const instance = { owner, epoch, identity, presentation, sequence: 0, fingerprint: null as string | null };
    replica.current = instance;
    closing.current = false;
    setEdit({ identity, revision: 0, composing: false });
    setRenderer("checking");
    void presentation.listen().then(ready => { if (ready && isCurrent()) publish(); });
    return () => {
      active = false;
      if (replica.current === instance) replica.current = null;
      void presentation.retire();
    };
  }, [admitted, model.uid, model.ready, epoch, privacyGeneration, presentationBlocked, privacyActive, props.scene, props.destinationId, publish]);
  useLayoutEffect(() => { publish(); });
  useBackLayer(pathname, renderer === "web" ? 0 : 100, () => {
    if (live.current.model.saving || closing.current) return true;
    const current = replica.current;
    if (!current) return renderer !== "web";
    closing.current = true;
    void current.presentation.retire().then(retired => {
      if (retired && replica.current === current && nativeDrawerOwnerIsCurrent(current.identity)) live.current.props.onCancel?.();
    });
    return true;
  }, props.destinationId ? { profile_pane: "1" } : undefined);
  if (renderer !== "web") return <div aria-busy={renderer === "checking"} data-native-profile-name-state={renderer} />;
  const form = props.fallback;
  return props.portalFallback ? props.webHost ? createPortal(form, props.webHost) : null : form;
}
