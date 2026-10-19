"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { createNativeDrawerIdentity, nativeDrawerOwnerIsCurrent } from "./native-drawer-owner";
import { NativeDrawerPresentation, type NativeDrawerActions } from "./native-drawer-presentation";
import { nativeDrawers, nativeDrawersPlatformEligible, nativeDrawerAcknowledged, type NativeDrawerFamily, type NativeDrawerSection, type NativeProfilePage, type NativeDrawerProjection } from "./native-drawers";
import { useNativeControlAppearance } from "./native-control-appearance";
import { getNativeSessionPrivacyState, nativePrivacyObservation, subscribeNativePrivacyObservation, subscribeNativeSessionPrivacy, type NativeSessionPrivacyState } from "./session-privacy";

export type NativeDrawerPort = {
  family: NativeDrawerFamily; owner: string | null; vaultEpoch: number; ready: boolean;
  open: boolean; title: string; searchable?: boolean; loading?: boolean;
  profileMenuRows?: boolean;
  enabled?: boolean;
  surfaceOpen?: boolean;
  onPresented?: (state: NativeDrawerProjection) => void;
  onHidden?: (state: NativeDrawerProjection) => void;
  onAbsenceConfirmed?: (privacyGeneration: number) => void;
  project: (handles: Map<string, string>) => { sections: NativeDrawerSection[]; navigationLocked?: boolean; profileStack?: readonly NativeProfilePage[]; profileDestinationId?: string; profileSupportDestinationId?: string; actions: NativeDrawerActions };
};

/** Both drawer families share one owner/privacy admission path. Only authored
 * volatile row projections cross this boundary; operation callbacks stay here. */
export function useNativeDrawerPresentation(port: NativeDrawerPort): "web" | "preparing" | "native" | "blocked" {
  const theme = useNativeControlAppearance("secondary");
  const [supported, setSupported] = useState<boolean | null>(() => nativeDrawersPlatformEligible() ? null : false);
  const [phase, setPhase] = useState<"web" | "preparing" | "native" | "blocked">("preparing");
  const [privacy, setPrivacy] = useState<NativeSessionPrivacyState | null>(null);
  const [admission, readmit] = useState(0);
  const previousOpen = useRef(port.open);
  const contentHandoffSupported = useRef(false);
  const current = useRef({ port, theme }); current.current = { port, theme };
  const privacyRef = useRef(privacy); privacyRef.current = privacy;
  const absentLease = useRef<{ isCurrent: () => boolean; privacy: number; delivered: boolean } | null>(null);
  const reportAbsence = () => {
    const known = absentLease.current;
    if (!known || known.delivered || current.current.port.open || !known.isCurrent()) return;
    known.delivered = true;
    current.current.port.onAbsenceConfirmed?.(known.privacy);
  };
  const replica = useRef<{ presentation: NativeDrawerPresentation; update: number; privacy: number;
    owner: string; epoch: number; handles: Map<string, string>; fingerprint: string | null } | null>(null);
  useLayoutEffect(() => {
    const requested = port.open && !previousOpen.current;
    previousOpen.current = port.open;
    // A new explicit Open may prepare a fresh lease after confirmed absence.
    // Never replay a row operation, retry an uncertain retirement, or loop on
    // an unchanged open state after a failed receipt.
    if (requested && supported === true && phase === "web") readmit(value => value + 1);
  }, [port.open, supported, phase]);
  const publish = (force = false): boolean => {
    const live = replica.current, nextPort = current.current.port;
    if (!live || !current.current.theme || !nextPort.ready || live.owner !== nextPort.owner || live.epoch !== nextPort.vaultEpoch ||
      snapshotValidatedAuthSessionOwner()?.userId !== live.owner) return false;
    const next = nextPort.project(live.handles);
    const state = { ...live.presentation.identity, ...current.current.theme, privacyGeneration: live.privacy,
      title: nextPort.title, open: nextPort.open, enabled: nextPort.enabled !== false, backEnabled: !!next.actions.back,
      ...(contentHandoffSupported.current && nextPort.family === "profile" && nextPort.surfaceOpen !== undefined ? { surfaceOpen: nextPort.surfaceOpen } : {}),
      searchable: nextPort.searchable, loading: nextPort.loading, sections: next.sections,
      ...(next.navigationLocked === undefined ? {} : { navigationLocked: next.navigationLocked }),
      ...(next.profileStack ? { profileStack: next.profileStack, profileDestinationId: next.profileDestinationId,
        profileSupportDestinationId: next.profileSupportDestinationId } : {}) };
    const fingerprint = JSON.stringify(state); // Private in-memory comparison only.
    if (!force && fingerprint === live.fingerprint) { live.presentation.refreshActions(next.actions); return true; }
    if (!live.presentation.publish({ ...state, updateSequence: ++live.update }, next.actions)) return false;
    live.fingerprint = fingerprint;
    return true;
  };
  useEffect(() => {
    if (!nativeDrawersPlatformEligible()) return;
    let active = true, observed = 0;
    let observer: Awaited<ReturnType<typeof subscribeNativeSessionPrivacy>> | null = null;
    const acceptPrivacy = (event: NativeSessionPrivacyState) => {
      if (!active || event.generation < (privacyRef.current?.generation ?? 0)) return;
      observed++; privacyRef.current = event; setPrivacy(event);
    };
    // Validation receipts may release the cover without another native event.
    // Observe the shared authoritative result; this consumer never releases it.
    const removeObservation = subscribeNativePrivacyObservation(() => {
      const state = nativePrivacyObservation().state;
      if (state) acceptPrivacy(state);
    });
    const initialPrivacy = nativePrivacyObservation().state;
    if (initialPrivacy) acceptPrivacy(initialPrivacy);
    void subscribeNativeSessionPrivacy(acceptPrivacy).then(handle => {
      if (!active) { void handle.remove(); return; }
      observer = handle;
      const ordinal = observed;
      return nativeDrawerAcknowledged(getNativeSessionPrivacyState()).then(state => {
        if (active && ordinal === observed) { privacyRef.current = state; setPrivacy(state); }
      });
    }).catch(() => { if (active) setPhase("blocked"); });
    void nativeDrawerAcknowledged(nativeDrawers.getCapabilities()).then(capability => {
      if (active) contentHandoffSupported.current = capability.profileContentHandoff === true;
      if (active) setSupported(capability.contractVersion === 1 && capability.supported && capability.wholePresentation &&
        (port.family !== "history" || capability.historyActions === true) &&
        (port.family !== "agent-profile" || capability.agentProfileMenu === true) &&
        (!port.profileMenuRows || capability.profileMenuRows === true));
    }).catch(() => { if (active) setSupported(false); });
    return () => { active = false; removeObservation(); void observer?.remove(); };
  }, [port.family, port.profileMenuRows]);
  useEffect(() => {
    if (!supported || !port.ready || !port.owner || snapshotValidatedAuthSessionOwner()?.userId !== port.owner ||
      privacy?.generation === undefined || privacy.shielded || !privacy.appIsActive) return;
    const identity = createNativeDrawerIdentity(port.family);
    if (!identity) return;
    absentLease.current = null;
    const owner = port.owner, epoch = port.vaultEpoch, generation = privacy.generation;
    let active = true;
    const isCurrent = () => active && current.current.port.ready && current.current.port.owner === owner &&
      snapshotValidatedAuthSessionOwner()?.userId === owner && current.current.port.vaultEpoch === epoch &&
      privacyRef.current?.generation === generation && !privacyRef.current.shielded && privacyRef.current.appIsActive &&
      nativeDrawerOwnerIsCurrent(identity);
    const presentation = new NativeDrawerPresentation(identity, nativeDrawers, isCurrent, next => {
      if (active) setPhase(next === "active" ? "native" : next === "retired" ? "web" : next === "quarantined" ? "blocked" : "preparing");
      // Only the existing retirement owner emits `retired`, after confirmed
      // disappearance. Quarantine/timeout must never release a modal handoff.
      if (next === "retired" && isCurrent()) {
        absentLease.current = { isCurrent, privacy: generation, delivered: false };
        reportAbsence();
      }
    }, state => {
      if (!isCurrent() || state.open !== current.current.port.open) return;
      if (state.open) current.current.port.onPresented?.(state);
      else current.current.port.onHidden?.(state);
    },
    () => isCurrent() && publish(true));
    const instance = { presentation, update: 0, privacy: generation, owner, epoch, handles: new Map<string, string>(), fingerprint: null as string | null };
    replica.current = instance; setPhase("preparing");
    void (async () => { if (await presentation.listen() && isCurrent()) publish(); })()
      .catch(() => { if (active) { setPhase("blocked"); void presentation.retire(); } });
    return () => {
      active = false;
      if (absentLease.current?.isCurrent === isCurrent) absentLease.current = null;
      if (replica.current === instance) replica.current = null;
      void presentation.retire();
    };
  }, [supported, port.family, port.ready, port.owner, port.vaultEpoch, privacy?.generation, privacy?.shielded, privacy?.appIsActive, admission]);
  useLayoutEffect(() => { publish(); reportAbsence(); });
  return supported === false ? "web" : phase;
}
