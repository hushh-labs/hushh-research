"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { nativeDrawers, type NativeProfilePage } from "@/lib/capacitor/native-drawers";
import { createNativeDrawerIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { NativeProfileScenePresentation, type NativeProfileSceneActions } from "@/lib/capacitor/native-profile-scene-presentation";
import { NativeProfilePricingFence, validNativeProfilePricingProjection, type NativeProfilePricingIdentity,
  type NativeProfilePricingProjection, type NativeProfilePricingEdit, type NativeProfilePricingAction,
  type NativeProfilePricingScenePort } from "@/lib/capacitor/native-profile-pricing-scene";
import { useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { formatDocumentRequestPrice } from "@/lib/consent/document-request-price";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { useDocumentRequestPricingModel } from "@/components/consent/use-document-request-pricing-model";

type Model = ReturnType<typeof useDocumentRequestPricingModel>;
export function projectNativeRequestPricing(model: Model, open: () => void) {
  const page: NativeProfilePage = { id: "request-pricing", title: "Request pricing", sections: [
    { id: "request-pricing-default", title: "Google Drive", rows: [
      { id: "request-pricing-status", label: "Price per request", artworkId: "request-pricing", enabled: true, readOnly: true,
        detail: model.loading ? "Loading price…" : model.saved?.enabled ? `${formatDocumentRequestPrice(model.saved.amountCents)} per request` : model.saved ? "Ask each time" : "Price unavailable" },
      ...(model.saved ? [
        { id: "request-pricing-edit", label: "Default price (USD)", enabled: !model.saving, chevron: true },
        ...(model.saved.enabled ? [{ id: "request-pricing-ask", label: "Ask each time", enabled: !model.saving }] : []),
      ] : !model.loading ? [{ id: "request-pricing-retry", label: "Retry", enabled: true }] : []),
    ] },
    { id: "request-pricing-fees", title: "Fees", rows: [
      { id: "request-pricing-fee", label: "From your earnings", detail: "3% Hushh fee + Stripe fees.", enabled: true, readOnly: true },
    ] },
    ...(model.error || model.notice ? [{ id: "request-pricing-outcome", rows: [
      { id: "request-pricing-message", label: model.error || model.notice!, enabled: true, readOnly: true },
    ] }] : []),
  ] };
  return { page, rows: new Map<string, () => void | Promise<void>>([
    ["request-pricing-edit", open], ["request-pricing-retry", model.retry], ["request-pricing-ask", () => model.save(false)],
  ]) };
}

export function NativeRequestPricingEditor({ model, userId, destinationId, onClose, onFallback }: {
  model: Model; userId: string; destinationId: string; onClose: () => void; onFallback: () => void;
}) {
  const pathname = usePathname();
  const appearance = useNativeControlAppearance("secondary");
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [phase, setPhase] = useState("checking");
  const [edit, setEdit] = useState<{ identity: NativeProfilePricingIdentity | null; revision: number; composing: boolean }>({ identity: null, revision: 0, composing: false });
  const live = useRef({ model, appearance, privacy, edit, userId, destinationId, onClose, onFallback });
  useLayoutEffect(() => { live.current = { model, appearance, privacy, edit, userId, destinationId, onClose, onFallback }; });
  type Presentation = NativeProfileScenePresentation<NativeProfilePricingProjection, NativeProfilePricingEdit, NativeProfilePricingAction, undefined>;
  const replica = useRef<{ identity: NativeProfilePricingIdentity; presentation: Presentation; sequence: number; fingerprint: string | null } | null>(null);
  const actions = useCallback((): NativeProfileSceneActions<NativeProfilePricingEdit, NativeProfilePricingAction, undefined> => ({
    edit: event => { live.current.model.change(event.text); setEdit({ identity: replica.current?.identity ?? null, revision: event.editRevision, composing: event.composing }); },
    commit: async () => { await live.current.model.save(true); return { kind: "retained" }; },
    saved: () => undefined, cancel: () => live.current.onClose(),
  }), []);
  const publish = useCallback(() => {
    const current = replica.current, next = live.current;
    if (!current || !next.appearance || !next.privacy || next.privacy.shielded || !next.privacy.appIsActive || !next.model.available) return;
    const edit = next.edit.identity === current.identity ? next.edit : { revision: 0, composing: false };
    const value: Omit<NativeProfilePricingProjection, "updateSequence"> = { ...current.identity, ...next.appearance, privacyGeneration: next.privacy.generation,
      acknowledgedEditRevision: edit.revision, draftRevision: edit.revision, draft: next.model.dollars,
      canSave: !!next.model.dirty && next.model.amountCents !== null && !next.model.saving && !edit.composing,
      busy: next.model.saving, error: next.model.error, notice: next.model.notice };
    const fingerprint = JSON.stringify(value); // Private in-memory equality, never diagnostics.
    if (fingerprint === current.fingerprint) { current.presentation.refreshActions(actions()); return; }
    if (current.presentation.publish({ ...value, updateSequence: ++current.sequence }, actions())) current.fingerprint = fingerprint;
  }, [actions]);
  const epoch = snapshotVaultSessionEpoch();
  const generation = privacy?.generation, shielded = privacy?.shielded, active = privacy?.appIsActive;
  useEffect(() => {
    if (generation === undefined || shielded || !active) return;
    const base = createNativeDrawerIdentity("profile");
    if (!base) return;
    const identity: NativeProfilePricingIdentity = { ...base, family: "profile", scene: "request-price", destinationId };
    let current = true;
    const isCurrent = () => current && live.current.userId === userId && live.current.destinationId === destinationId && live.current.model.available &&
      snapshotValidatedAuthSessionOwner()?.userId === userId && snapshotVaultSessionEpoch() === epoch && nativeDrawerOwnerIsCurrent(identity) &&
      live.current.privacy?.generation === generation && !live.current.privacy.shielded && live.current.privacy.appIsActive;
    const plugin = nativeDrawers as typeof nativeDrawers & NativeProfilePricingScenePort;
    const presentation = new NativeProfileScenePresentation<NativeProfilePricingProjection, NativeProfilePricingEdit, NativeProfilePricingAction, undefined>(identity, {
      source: plugin, apply: state => plugin.applyProfilePricingScene(state), confirm: action => plugin.confirmProfilePricingAction(action),
      settle: action => plugin.settleProfilePricingAction(action), retire: () => plugin.retireProfilePricingScene(identity),
      edits: listener => plugin.addListener("profilePricingEdit", listener), choices: listener => plugin.addListener("profilePricingAction", listener),
    }, new NativeProfilePricingFence(identity), validNativeProfilePricingProjection, isCurrent, phase => {
      if (!current) return; setPhase(phase); if (phase === "fallback") live.current.onFallback();
    }, false);
    const instance = { identity, presentation, sequence: 0, fingerprint: null as string | null };
    replica.current = instance; setEdit({ identity, revision: 0, composing: false });
    void presentation.listen().then(ready => { if (ready && isCurrent()) publish(); });
    return () => { current = false; if (replica.current === instance) replica.current = null; instance.fingerprint = null; void presentation.retire(); };
  }, [userId, destinationId, epoch, generation, shielded, active, publish]);
  useLayoutEffect(() => { publish(); });
  useBackLayer(pathname, 100, () => {
    const current = replica.current;
    if (!current || live.current.model.saving) return true;
    void current.presentation.retire().then(retired => { if (retired && replica.current === current && nativeDrawerOwnerIsCurrent(current.identity)) live.current.onClose(); });
    return true;
  }, { profile_pane: "1" });
  return <div aria-busy={phase === "checking"} data-native-profile-pricing-state={phase} />;
}
