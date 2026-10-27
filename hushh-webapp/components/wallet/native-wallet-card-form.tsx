"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { SettingsDetailPanel } from "@/components/profile/settings-ui";
import { Button } from "@/components/ui/button";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { nativeDrawerAcknowledged, nativeDrawers } from "@/lib/capacitor/native-drawers";
import { createNativePresentationIdentity, nativeDrawerOwnerIsCurrent } from "@/lib/capacitor/native-drawer-owner";
import { NativeOwnedScenePresentation } from "@/lib/capacitor/native-owned-scene-presentation";
import { nativeWalletCardFormsEnabled, NativeWalletCardFence, validNativeWalletCardProjection, validNativeWalletCardEdit,
  type NativeWalletCardDraft, type NativeWalletCardEdit, type NativeWalletCardAction, type NativeWalletCardProjection } from "@/lib/capacitor/native-wallet-card";
import { sameOwnedChoice, type OwnedChoiceIdentity } from "@/lib/capacitor/native-owned-choice";
import { useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { nativePrivacyObservation, subscribeNativePrivacyObservation, getNativeSessionPrivacyState } from "@/lib/capacitor/session-privacy";
import type { PluginListenerHandle } from "@capacitor/core";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { awaitNativeContentPaneRetirement, useNativeContentPane } from "@/lib/capacitor/use-native-content-pane";
import { COUNTRY_PHONE_OPTIONS } from "@/lib/constants/country-phone-options";
import { cardNetworkLabel } from "./card-network-mark";
import type { CardBrand } from "@/lib/wallet/card-validation";
import { useSecureCardFormOwner, SecureCardAddFormView, CARD_FORM_ERROR_COPY,
  type SecureCardFormOwner, type SecureCardAddFormProps } from "./secure-card-add-form";
import { WalletCardScanner } from "./wallet-card-scanner";
import presentationStyles from "./wallet-connect-presentation.module.css";
import workspaceStyles from "./wallet-workspace.module.css";

type Media = "camera" | "photos";
type Presentation = NativeOwnedScenePresentation<OwnedChoiceIdentity, NativeWalletCardProjection, NativeWalletCardEdit, NativeWalletCardAction, Media | undefined>;

/** One authoritative feature owner survives the chosen renderer and explicit
 * scan handoffs. Protected fields never enter public chrome or diagnostics. */
export function AdaptiveWalletCardForm({ open, ownerId, onReturnFocus, ...props }: SecureCardAddFormProps & {
  open: boolean; ownerId: string; onReturnFocus: () => void;
}) {
  const form = useSecureCardFormOwner({ ...props, active: open });
  const [fallback, setFallback] = useState(false), [media, setMedia] = useState<Media | null>(null);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const native = nativeWalletCardFormsEnabled() && !fallback;
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) { form.resetDraft(); setMedia(null); }
    wasOpen.current = open;
  }, [open, form]);
  // Owner replacement remounts this boundary; ordinary closure does not turn a
  // failed native lifetime back on during a later render.
  if (native) return open ? media ? <WalletScanHandoff source={media} ownerId={ownerId} form={form}
    backRoute={props.backRoute} onReturn={() => { form.setScanning(false); setMedia(null); }} /> :
    <NativeWalletCardForm ownerId={ownerId} form={form} collectSecurityCode={props.collectSecurityCode === true}
      scanEnabled={props.scanEnabled !== false} onCancel={() => { props.onCancel?.(); onReturnFocus(); }}
      onMedia={setMedia} onFallback={() => setFallback(true)} /> : null;
  return <SettingsDetailPanel open={open} onOpenChange={value => { if (!value) props.onCancel?.(); }}
    title="Add card" headerTextOverflow="wrap" desktopMaxWidth="560px" desktopMaxWidthClassName="sm:!max-w-[560px]"
    surfaceClassName={`${workspaceStyles.addPanel} ${presentationStyles.walletPortal} ${presentationStyles.walletDialog}`} bodyClassName={workspaceStyles.addBody}
    onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus(); }} footer={<div ref={setFooter} className={workspaceStyles.addFooter} />}>
    <SecureCardAddFormView {...props} active={open} owner={form} footerHost={footer} />
  </SettingsDetailPanel>;
}

function NativeWalletCardForm({ ownerId, form, collectSecurityCode, scanEnabled, onCancel, onMedia, onFallback }: {
  ownerId: string; form: SecureCardFormOwner; collectSecurityCode: boolean; scanEnabled: boolean;
  onCancel: () => void; onMedia: (source: Media) => void; onFallback: () => void;
}) {
  const appearance = useNativeControlAppearance("secondary"), pathname = usePathname();
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [phase, setPhase] = useState("preparing"), [edit, setEdit] = useState({ revision: 0, composing: false });
  const live = useRef({ form, ownerId, appearance, privacy, edit, onCancel, onMedia, onFallback });
  useLayoutEffect(() => { live.current = { form, ownerId, appearance, privacy, edit, onCancel, onMedia, onFallback }; });
  const installation = useRef<{ identity: OwnedChoiceIdentity; presentation: Presentation; sequence: number; fingerprint: string | null; draftRevision: number; discardFinal: boolean } | null>(null);
  const actions = useCallback(() => ({
    edit: (event: NativeWalletCardEdit) => {
      const f = live.current.form, d = event.draft;
      const entry = installation.current;
      if (!entry || !f.draftVisible) return;
      if (d.network !== "auto" && !f.supportedNetworks.includes(d.network as CardBrand) && d.network !== "other") return;
      if (d.issuingRegion !== "none" && !COUNTRY_PHONE_OPTIONS.some(option => option.value === d.issuingRegion)) return;
      f.markFieldsEdited();
      f.setPan(d.pan); f.setCardholderName(d.cardholderName); f.setExpiry(d.expiry);
      f.setNetwork(d.network === "auto" ? "" : d.network as CardBrand);
      f.setIssuingRegion(d.issuingRegion === "none" ? "" : d.issuingRegion);
      f.setSecurityCode(d.securityCode);
      live.current.edit = { revision: event.editRevision, composing: event.composing };
      setEdit(live.current.edit);
    },
    commit: async (event: NativeWalletCardAction) => {
      if (event.action === "change" && event.intent) return { kind: "saved" as const, value: event.intent };
      if (installation.current) installation.current.discardFinal = true;
      const accepted = await live.current.form.submit(true);
      if (!accepted && installation.current) installation.current.discardFinal = false;
      return accepted ? { kind: "saved" as const, value: undefined } : { kind: "retained" as const };
    },
    saved: (source: Media | undefined) => { if (source) live.current.onMedia(source); },
    cancel: () => { if (installation.current) installation.current.discardFinal = true; live.current.onCancel(); },
  }), []);
  const publish = useCallback(() => {
    const entry = installation.current, v = live.current, f = v.form;
    if (!entry || !v.appearance || !v.privacy?.appIsActive || v.privacy.shielded || !f.draftVisible) return;
    const draft: NativeWalletCardDraft = { pan: f.pan, cardholderName: f.cardholderName, expiry: f.expiry,
      securityCode: collectSecurityCode ? f.securityCode : "", network: f.network || "auto", issuingRegion: f.issuingRegion || "none" };
    const value = { ...entry.identity, ...v.appearance, privacyGeneration: v.privacy.generation,
      acknowledgedEditRevision: v.edit.revision, draftRevision: entry.draftRevision, draft,
      busy: f.submitting, canSave: !v.edit.composing && !f.submitting && !f.scanning,
      collectSecurityCode, scanEnabled, networkLoading: f.networkLoading, networkHint: f.networkHint ?? undefined,
      error: f.saveError ?? (f.errors.length ? f.errors.map(code => CARD_FORM_ERROR_COPY[code] ?? "Check your card details.").join("\n") : undefined),
      networks: [{ id: "auto", label: f.brand === "other" ? "Auto-detect" : `Auto-detect · ${cardNetworkLabel(f.brand)}`, selected: !f.network },
        ...(f.supportedNetworks.length ? f.supportedNetworks : ["other" as const]).map(id => ({ id, label: id === "other" ? "Other" : cardNetworkLabel(id), selected: f.network === id }))],
      regions: [{ id: "none", label: "Select region…", selected: !f.issuingRegion },
        ...COUNTRY_PHONE_OPTIONS.map(option => ({ id: option.value, label: option.label, selected: f.issuingRegion === option.value }))] };
    const fingerprint = JSON.stringify(value); // Private transient memory; never logged.
    if (entry.fingerprint === fingerprint) { entry.presentation.refreshActions(actions()); return; }
    // Listener setup is asynchronous. A refused pre-listen publication must
    // not consume the first native admission sequence.
    const sequence = entry.sequence + 1;
    if (entry.presentation.publish({ ...value, updateSequence: sequence }, actions())) {
      entry.sequence = sequence; entry.fingerprint = fingerprint;
    }
  }, [actions, collectSecurityCode, scanEnabled]);
  const generation = privacy?.generation, active = privacy?.appIsActive && !privacy.shielded;
  const epoch = snapshotVaultSessionEpoch(), ownerKey = form.ownerKey;
  useEffect(() => {
    if (!active || generation === undefined || !ownerId) return;
    const base = createNativePresentationIdentity(); if (!base) return;
    const identity = { ...base, visitId: crypto.randomUUID() };
    const draftLifetime = live.current.form.draftLifetime, draftToken = draftLifetime.current.token;
    let current = true;
    const isCurrent = () => current && live.current.ownerId === ownerId && live.current.form.ownerKey === ownerKey &&
      live.current.form.draftVisible && draftLifetime.current.alive && draftLifetime.current.token === draftToken && snapshotVaultSessionEpoch() === epoch && nativeDrawerOwnerIsCurrent(identity) &&
      live.current.privacy?.generation === generation && live.current.privacy.appIsActive && !live.current.privacy.shielded;
    const plugin = nativeDrawers();
    let presentation: Presentation | undefined;
    let acceptFinal = true, finalHandle: PluginListenerHandle | undefined;
    let finalReconciliation: Promise<unknown> = Promise.resolve();
    const retainedOwner = () => live.current.ownerId === ownerId && live.current.form.ownerKey === ownerKey &&
      snapshotVaultSessionEpoch() === epoch && nativeDrawerOwnerIsCurrent(identity) && draftLifetime.current.alive && draftLifetime.current.token === draftToken;
    const releaseFinal = () => { acceptFinal = false; void finalHandle?.remove().catch(() => undefined); stopEpoch(); stopPrivacy(); window.removeEventListener("pagehide", releaseFinal); };
    const checkOwner = () => { if (!retainedOwner()) releaseFinal(); };
    const stopEpoch = subscribeVaultSessionEpoch(checkOwner), stopPrivacy = subscribeNativePrivacyObservation(checkOwner);
    window.addEventListener("pagehide", releaseFinal);
    void (async () => {
      try {
        await awaitNativeContentPaneRetirement();
        const capabilities = await nativeDrawerAcknowledged(plugin.getCapabilities());
        if (!isCurrent()) return;
        if (!capabilities.walletCardForms || !plugin.applyWalletCardScene || !plugin.confirmWalletCardAction ||
            !plugin.settleWalletCardAction || !plugin.retireWalletCardScene) { live.current.onFallback(); return; }
        presentation = new NativeOwnedScenePresentation(identity, {
          source: plugin, apply: state => plugin.applyWalletCardScene!(state), confirm: async event => {
            const result = await plugin.confirmWalletCardAction!(event);
            if (result.valid && event.action === "cancel" && installation.current?.identity === identity) installation.current.discardFinal = true;
            return result;
          },
          settle: event => plugin.settleWalletCardAction!(event), retire: async id => { const receipt = await plugin.retireWalletCardScene!(id); await finalReconciliation; return receipt; },
          edits: callback => plugin.addListener("walletCardEdit", callback), choices: callback => plugin.addListener("walletCardAction", callback),
        }, new NativeWalletCardFence(identity), validNativeWalletCardProjection, isCurrent,
        next => { if (current) { setPhase(next); if (next === "fallback") live.current.onFallback(); } },
        true, state => ({ ...state, draft: { ...state.draft } }), isCurrent, sameOwnedChoice);
        const entry = { identity, presentation, sequence: 0, fingerprint: null, draftRevision: 0, discardFinal: false };
        installation.current = entry;
        const finalPending = plugin.addListener("walletCardFinalEdit", event => {
          const f = live.current.form;
          if (!acceptFinal || entry.discardFinal || !sameOwnedChoice(event, identity) || !validNativeWalletCardEdit(event) ||
              event.composing || event.privacyGeneration !== generation || event.baseDraftRevision !== entry.draftRevision ||
              event.editRevision <= live.current.edit.revision || !retainedOwner()) return;
          // Retirement carries committed text only, never a save. CVV must not
          // be repopulated after the app's inactivity scrub.
          finalReconciliation = nativeDrawerAcknowledged(getNativeSessionPrivacyState()).then(currentPrivacy => {
            if (!acceptFinal || entry.discardFinal || !retainedOwner()) return;
            f.setPan(event.draft.pan); f.setCardholderName(event.draft.cardholderName); f.setExpiry(event.draft.expiry);
            f.setNetwork(event.draft.network === "auto" ? "" : event.draft.network as CardBrand);
            f.setIssuingRegion(event.draft.issuingRegion === "none" ? "" : event.draft.issuingRegion);
            f.setSecurityCode(currentPrivacy.generation === event.privacyGeneration && currentPrivacy.appIsActive && !currentPrivacy.shielded && document.visibilityState === "visible" ? event.draft.securityCode : "");
            releaseFinal();
          }).catch(() => { releaseFinal(); });
        });
        void finalPending.then(handle => { if (!acceptFinal) void handle.remove().catch(() => undefined); }).catch(() => undefined);
        finalHandle = await nativeDrawerAcknowledged(finalPending);
        live.current.edit = { revision: 0, composing: false };
        setEdit(live.current.edit);
        if (await presentation.listen() && isCurrent()) publish();
      } catch {
        if (presentation) { if (await presentation.retire() && isCurrent()) live.current.onFallback(); }
        else if (isCurrent()) live.current.onFallback();
      }
    })();
    return () => {
      current = false; installation.current = null;
      if (presentation) void presentation.retire().then(async retired => { await finalReconciliation; if (retired || !retainedOwner()) releaseFinal(); });
      else releaseFinal();
    };
  }, [active, generation, ownerId, ownerKey, epoch, publish]);
  useLayoutEffect(() => { publish(); });
  useBackLayer(pathname, 100, () => {
    const entry = installation.current;
    if (entry && !live.current.form.submitting) { entry.discardFinal = true; void entry.presentation.retire().then(retired => {
      if (retired && installation.current === entry && nativeDrawerOwnerIsCurrent(entry.identity)) live.current.onCancel();
    }); }
    return true;
  });
  return <div aria-busy={phase === "preparing"} data-native-wallet-card={phase} />;
}

/** Explicit rich-scanner exception: retire the native form first, then give
 * its existing React crop/review owner the complete focused WebView plane. */
function WalletScanHandoff({ source, ownerId, form, backRoute, onReturn }: {
  source: Media; ownerId: string; form: SecureCardFormOwner; backRoute?: string; onReturn: () => void;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const plane = useNativeContentPane(node, ownerId, true, "wallet-card-scan");
  const ready = plane.phase === "native" || plane.phase === "web";
  return createPortal(<div ref={setNode} className="fixed inset-0 z-[var(--z-modal)] overflow-y-auto bg-background px-5 pb-[env(safe-area-inset-bottom)] pt-[calc(env(safe-area-inset-top)+1rem)]"
    style={{ visibility: ready ? "visible" : "hidden" }} role="dialog" aria-modal="true" aria-label="Scan card">
    <div className="mx-auto flex max-w-lg flex-col gap-5">
      <header className="flex min-h-11 items-center justify-between"><h2>Scan card</h2><Button variant="ghost" onClick={onReturn}>Cancel</Button></header>
      <WalletCardScanner active={ready} disabled={false} backRoute={backRoute} initialSource={source}
        onExit={onReturn} onRead={form.readScan} onBusyChange={form.setScanning} />
    </div>
  </div>, document.body);
}
