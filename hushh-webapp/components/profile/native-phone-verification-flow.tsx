"use client";

import { nativeProfileSceneCanPrepare, nativeProfileActionsAllowed } from "@/lib/capacitor/native-profile-preparation";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { PhoneVerificationForm, maskPhoneNumberForOtp, usePhoneVerificationFlow, type PhoneVerificationFlowProps,
  type PhoneVerificationModel } from "@/components/auth/phone-verification-flow";
import { nativeDrawers, nativeDrawerAcknowledged, type HushhNativeDrawersPlugin } from "@/lib/capacitor/native-drawers";
import { createNativeDrawerIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { NativeProfileScenePresentation, type NativeProfileSceneActions } from "@/lib/capacitor/native-profile-scene-presentation";
import { NativePhoneFence, validNativePhoneProjection, type NativePhoneIdentity, type NativePhoneProjection,
  type NativePhoneEdit, type NativePhoneAction, type NativePhoneScenePort } from "@/lib/capacitor/native-profile-phone-scene";
import type { NativePhoneDraft } from "@/lib/capacitor/native-profile-phone-scene";
import { useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { getNativeSessionPrivacyState, nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useBackLayer } from "@/lib/navigation/back-layers";

/** Mounted once per phone visit, outside either presentation. Renderer fallback
 * keeps the same feature model, pending attempt, final digits and Back owner. */
export function NativePhoneVerificationFlow({ native, destinationId, webHost, onFallback, ...props }: PhoneVerificationFlowProps & {
  native: boolean; destinationId?: string; webHost: HTMLElement | null; onFallback: () => void;
}) {
  const [unfinished, setUnfinished] = useState<NativePhoneDraft | null>(null);
  const unfinishedRef = useRef(unfinished);
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const remember = useCallback((value: NativePhoneDraft | null) => {
    unfinishedRef.current = value; setUnfinished(value);
  }, []);
  useLayoutEffect(() => { if (privacy?.shielded) remember(null); }, [privacy?.shielded, privacy?.generation, remember]);
  const model = usePhoneVerificationFlow({ ...props, operationAllowed: () => !unfinishedRef.current && props.operationAllowed?.() !== false });
  useLayoutEffect(() => { remember(null); }, [props.ownerKey, model.step, remember]);
  if (native && !destinationId) return <div aria-busy="true" />;
  if (native && destinationId) return <NativePhoneScene model={model} destinationId={destinationId} mode={props.mode}
    onDraft={remember} onCancel={props.onCancel ?? (() => undefined)} onFallback={onFallback} />;
  // Preserve uncommitted text across confirmed renderer fallback. The first
  // ordinary edit commits through the shared normalizer. Until then every
  // operation port refuses to submit the older authoritative digits.
  const commitNumber = (value: string, country = unfinished?.country) => {
    const accepted = model.handlePhoneNumberChange(value, country);
    if (accepted) remember(null);
    else if (unfinished) remember({ ...unfinished, number: value });
    return accepted;
  };
  const presentation = unfinished ? { ...model,
    localPhoneNumber: model.step === "phone" ? unfinished.number : model.localPhoneNumber,
    verificationCode: model.step === "code" ? unfinished.code : model.verificationCode,
    handlePhoneNumberChange: commitNumber,
    handlePhoneNumberPaste: (event: React.ClipboardEvent<HTMLInputElement>) => {
      event.preventDefault();
      const start = event.currentTarget.selectionStart ?? 0, end = event.currentTarget.selectionEnd ?? unfinished.number.length;
      commitNumber(`${unfinished.number.slice(0, start)}${event.clipboardData.getData("text")}${unfinished.number.slice(end)}`);
    },
    handleCountrySelection: (country: string | null) => { if (country) commitNumber(unfinished.number, country); },
    changeCode: (value: string) => { remember(null); model.changeCode(value); },
  } : model;
  return webHost ? createPortal(<PhoneVerificationForm {...props} model={presentation} submissionBlocked={unfinished !== null} />, webHost) : null;
}

function NativePhoneScene({ model, destinationId, mode, onCancel, onFallback, onDraft }: {
  model: PhoneVerificationModel; destinationId: string; mode: "link" | "replace"; onCancel: () => void; onFallback: () => void;
  onDraft: (draft: NativePhoneDraft | null) => void;
}) {
  const plugin = nativeDrawers() as HushhNativeDrawersPlugin & NativePhoneScenePort;
  const pathname = usePathname();
  const appearance = useNativeControlAppearance("secondary");
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [phase, setPhase] = useState("checking");
  const [, acknowledgeEdit] = useState(0);
  const live = useRef({ model, mode, appearance, privacy, onCancel, onFallback, onDraft });
  useLayoutEffect(() => { live.current = { model, mode, appearance, privacy, onCancel, onFallback, onDraft }; });
  type Presentation = NativeProfileScenePresentation<NativePhoneProjection, NativePhoneEdit, NativePhoneAction, undefined>;
  const replica = useRef<{ identity: NativePhoneIdentity; presentation: Presentation; sequence: number;
    editRevision: number; composing: boolean; fingerprint: string | null; backReleased: boolean } | null>(null);
  const actions = useCallback((): NativeProfileSceneActions<NativePhoneEdit, NativePhoneAction, undefined> => ({
    edit: event => {
      const current = replica.current, model = live.current.model;
      if (!current || event.step !== model.step) return;
      current.editRevision = event.editRevision; current.composing = event.composing;
      live.current.onDraft(event.composing ? { ...event.draft } : null);
      if (!event.composing) {
        if (model.step === "phone") model.handlePhoneNumberChange(event.draft.number, event.draft.country);
        else if (model.step === "code") model.changeCode(event.draft.code);
      }
      acknowledgeEdit(event.editRevision);
    },
    commit: async event => {
      const model = live.current.model;
      if (!model.current()) return { kind: "retained" };
      if (event.intent === "send") await model.handleStartVerification();
      else if (event.intent === "verify") await model.handleConfirmVerification();
      else if (event.intent === "resend") await model.handleStartVerification(true, model.submittedPhoneNumber);
      else if (event.intent === "back") model.returnToPhoneNumber();
      else if (event.intent === "continue") await model.handleContinueExisting();
      return { kind: "retained" };
    },
    saved: () => undefined,
    cancel: () => {
      // Scene cancellation is invoked only after confirmed native retirement.
      // Release this mounted layer before the route owner unwinds Back, or
      // it consumes its own cancellation and calls the same owner again.
      const current = replica.current;
      if (!current || current.backReleased) return;
      current.backReleased = true;
      live.current.onCancel();
    },
  }), []);
  const publish = useCallback(() => {
    const current = replica.current, next = live.current;
    if (!current || current.backReleased || !next.model.current() || !next.appearance || !next.privacy || !nativeProfileSceneCanPrepare(next.privacy, current.identity.scene, current.identity.destinationId)) return;
    const { model } = next;
    const state = { ...current.identity, ...next.appearance, privacyGeneration: next.privacy.generation,
      draftRevision: current.sequence + 1, acknowledgedEditRevision: current.editRevision,
      draft: { country: model.selectedCountry, number: model.localPhoneNumber, code: model.verificationCode }, step: model.step, mode: next.mode,
      countries: model.countries.map(({ value, label, dialCode }) => ({ value, label, dialCode })),
      maskedDestination: model.step === "linked" ? model.maskedPhone : maskPhoneNumberForOtp(model.submittedPhoneNumber),
      canSave: !model.busy && !current.composing, busy: model.busy,
      error: model.operationError ?? (model.step === "code" ? model.codeError : model.phoneNumberError) };
    const fingerprint = JSON.stringify({ ...state, draftRevision: 0 }); // In-memory equality only; never diagnostics.
    if (fingerprint === current.fingerprint) { current.presentation.refreshActions(actions()); return; }
    if (current.presentation.publish({ ...state, updateSequence: ++current.sequence }, actions())) current.fingerprint = fingerprint;
  }, [actions]);
  useEffect(() => { if (!nativePrivacyObservation().state) void nativeDrawerAcknowledged(getNativeSessionPrivacyState()).catch(() => setPhase("blocked")); }, []);
  const epoch = snapshotVaultSessionEpoch();
  const generation = privacy?.generation, presentationBlocked = !nativeProfileSceneCanPrepare(privacy, "phone", destinationId), active = privacy?.appIsActive;
  useEffect(() => {
    if (!model.ready || generation === undefined || presentationBlocked || !active || !live.current.model.current()) return;
    const base = createNativeDrawerIdentity("profile");
    if (!base) return;
    const identity: NativePhoneIdentity = { ...base, family: "profile", scene: "phone", destinationId };
    let current = true;
    const isCurrent = () => current && live.current.model.current() && snapshotVaultSessionEpoch() === epoch && nativeDrawerOwnerIsCurrent(identity) &&
      live.current.privacy?.generation === generation && nativeProfileSceneCanPrepare(live.current.privacy, identity.scene, identity.destinationId);
    const presentation = new NativeProfileScenePresentation<NativePhoneProjection, NativePhoneEdit, NativePhoneAction, undefined>(identity, {
      source: plugin, apply: state => plugin.applyProfilePhoneScene(state), confirm: event => plugin.confirmProfilePhoneAction(event),
      settle: event => plugin.settleProfilePhoneAction(event), retire: () => plugin.retireProfilePhoneScene(identity),
      edits: callback => plugin.addListener("profilePhoneEdit", callback), choices: callback => plugin.addListener("profilePhoneAction", callback),
    }, new NativePhoneFence(identity), validNativePhoneProjection, isCurrent, next => {
      if (!current) return;
      setPhase(next); if (next === "fallback") live.current.onFallback();
    }, false, state => ({ ...state, draft: { ...state.draft }, countries: state.countries.map(option => ({ ...option })) }), () => isCurrent() && nativeProfileActionsAllowed());
    replica.current = { identity, presentation, sequence: 0, editRevision: 0, composing: false, fingerprint: null, backReleased: false };
    void presentation.listen().then(ready => { if (ready && isCurrent()) publish(); });
    return () => { current = false; if (replica.current?.identity === identity) replica.current = null; void presentation.retire(); };
  }, [destinationId, model.ready, epoch, generation, presentationBlocked, active, plugin, actions, publish]);
  useLayoutEffect(() => { publish(); });
  useBackLayer(pathname, 100, () => {
    const current = replica.current;
    if (current?.backReleased) return false;
    if (!current || live.current.model.busy) return true;
    if (live.current.model.step === "code") { live.current.model.returnToPhoneNumber(); return true; }
    void current.presentation.retire().then(retired => {
      if (retired && replica.current === current && !current.backReleased && nativeDrawerOwnerIsCurrent(current.identity)) {
        current.backReleased = true;
        live.current.onCancel();
      }
    });
    return true;
  }, destinationId ? { profile_pane: "1" } : undefined);
  return <div aria-busy={phase === "checking"} data-native-profile-phone-state={phase} />;
}
