"use client";

import { useNativeWorkspaceEvent, createNativeWorkspaceHandles, useNativeWorkspaceHandoff } from "@/lib/capacitor/use-native-workspace-handoff";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { usePathname } from "next/navigation";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { useNativeWorkspace, useNativeWorkspacePresentation, type NativeWorkspaceContent } from "@/lib/capacitor/use-native-workspace";
import type { NativeWorkspaceChoice, NativeWorkspaceMemoryDraft } from "@/lib/capacitor/native-workspace";
import { nativePrivacyCanInteract, nativePrivacyObservation } from "@/lib/capacitor/session-privacy";

import { ROUTES, normalizeStaticExportPathname } from "@/lib/navigation/routes";
import { openProfilePane } from "@/lib/navigation/profile-pane";
import { useProfilePanePresentation } from "@/lib/navigation/use-profile-pane-presentation";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useMemoryCommerceSummary, type MemoryCommerceSummaryModel } from "./memory-commerce-summary";
import { usePkmSharingExpansion, type PkmSharingExpansion } from "./pkm-saved-sharing";
import { nativeMemorySaved, type NativeMemorySavedHandoff } from "./native-memory-saved";
import type { PkmNaturalModel } from "./use-pkm-natural-model";

export type NativeMemoryRetainedOwners = {
  commerce: MemoryCommerceSummaryModel;
  sharing: PkmSharingExpansion;
};
type WebChild = "soul-editor" | "sharing" | "detail" | "payments" | "navigation";

/** Memory keeps one model and one workspace lease. Explicit
 * rich child actions retire native before the complete authored web child is
 * exposed; owner and privacy are rechecked after that asynchronous handoff. */
export function NativeMemoryWorkspace({ model, renderFallback }: {
  model: PkmNaturalModel;
  renderFallback: (owners: NativeMemoryRetainedOwners) => ReactNode;
}) {
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const profilePane = useProfilePanePresentation();
  const presentation = useNativeWorkspacePresentation();
  const contentFrame = useRef<HTMLElement | null>(null);
  const [child, setChild] = useState<{ kind: WebChild; seen: boolean } | null>(null);
  const { handoff: retireForChild, activationRevision, intent } = useNativeWorkspaceHandoff(presentation.retireForWeb, model.presentationIdentity);
  const latest = useRef({ model, pathname });
  useLayoutEffect(() => { latest.current = { model, pathname }; });
  useLayoutEffect(() => {
    // A child belongs to one unlocked presentation. A lock or owner change
    // must not leave an unobserved handoff suppressing the next session.
    setChild(null);
  }, [model.presentationIdentity]);
  const commerce = useMemoryCommerceSummary(model.canOpen);
  const sharing = usePkmSharingExpansion(model.ownerId, model.canOpen, model.presentationIdentity);
  const handles = useMemo(() => createNativeWorkspaceHandles(String(model.ownerId)), [model.ownerId]);
  const routeCurrent = useNativeWorkspaceEvent(() => latest.current.pathname === ROUTES.PKM && latest.current.model.ownerId === model.ownerId &&
    latest.current.model.presentationIdentity === model.presentationIdentity &&
    latest.current.model.captureSessionCurrent() && nativePrivacyCanInteract(nativePrivacyObservation().state));
  const handoff: NativeMemorySavedHandoff = useNativeWorkspaceEvent<Parameters<NativeMemorySavedHandoff>, ReturnType<NativeMemorySavedHandoff>>(async (kind, action) => {
    return retireForChild(routeCurrent, () => {
      const currentModel = latest.current.model;
      return !(kind === "detail" && (currentModel.memoryCards !== model.memoryCards || currentModel.metadata !== model.metadata ||
        currentModel.homeSearchQuery !== model.homeSearchQuery) ||
        kind === "soul-editor" && currentModel.soul.current?.document !== model.soul.current?.document ||
        kind === "sharing" && currentModel.sharingManifests !== model.sharingManifests);
    }, () => { setChild({ kind, seen: false }); action(); });
  });
  const profileOpen = profilePane?.open === true;
  const childOpen = child?.kind === "soul-editor" ? model.soul.editing : child?.kind === "sharing" ? sharing.section !== "" :
    child?.kind === "detail" ? !!model.selectedCard || !!model.selectedMetadataDomain : child?.kind === "payments" ? profileOpen : false;
  useLayoutEffect(() => {
    if (!child) return;
    if (child.kind === "navigation") {
      if (pathname !== ROUTES.PKM && !child.seen) setChild({ ...child, seen: true });
      else if (pathname === ROUTES.PKM && child.seen) setChild(null);
      return;
    }
    if (childOpen && !child.seen) {
      setChild({ ...child, seen: true });
      // Native and Web have separate scroll positions. Reveal the exact
      // authored child after its confirmed handoff rather than stranding it
      // below the long Memory document.
      const requested = intent.current;
      requestAnimationFrame(() => {
        if (requested !== intent.current || !routeCurrent()) return;
        if (child.kind === "sharing") document.querySelector<HTMLElement>('[data-pkm-memory-sharing="true"]')?.scrollIntoView?.({ block: "start" });
        else document.querySelector<HTMLElement>('[data-app-scroll-root="true"]')?.scrollTo?.({ top: 0, behavior: "instant" });
      });
    }
    else if (!childOpen && child.seen) setChild(null);
  }, [child, childOpen, pathname, intent, routeCurrent]);
  const nativeRequested = customNativePresentationEnabled();
  const nativePrivateReady = nativeRequested && model.canOpen && nativePrivacyCanInteract(nativePrivacyObservation().state);
  const saved = nativePrivateReady ? nativeMemorySaved({ model, commerce, handle: handles, handoff,
    openSharing: () => sharing.setSection("sharing"),
    openPayments: () => openProfilePane(window.location.pathname, window.location.search, { panel: "payouts", detail: null }, { returnsToOrigin: true }) }) : null;
  const active = nativeRequested && pathname === ROUTES.PKM && model.canOpen && model.captureSessionCurrent() &&
    !!saved && !child;
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  for (const [id, action] of saved?.actions ?? []) actions.set(id, action);
  const content: NativeWorkspaceContent = { workspace: "memory", page: "overview", title: "Memory", enabled: active, backEnabled: false,
    sections: saved?.sections ?? [] };
  const phase = useNativeWorkspace<NativeWorkspaceMemoryDraft>({ owner: model.ownerId, content, actions, current: routeCurrent,
    back: () => {}, active, presentationOwner: presentation.owner, contentFrame: contentFrame as RefObject<HTMLElement | null>,
    activationRevision });
  const diagnostic = !nativeRequested ? "policy" : pathname !== ROUTES.PKM || !nativePrivateReady || !model.captureSessionCurrent() || model.authLoading ? "session" :
    child || model.selectedCard || model.selectedMetadataDomain || model.soul.editing ? "owned-child" :
    !saved ? "saved-projection-bounds" : "admission";
  useEffect(() => {
    // Test-launch bridge only: no document, record, owner, or user values.
    const bridge = window.__HUSHH_NATIVE_TEST__ as (NonNullable<Window["__HUSHH_NATIVE_TEST__"]> & {
      memoryAdmission?: { reason: string; phase: string; ownerPhase: string; ownerReason: string };
    }) | undefined;
    if (!bridge?.enabled) return;
    const snapshot = { reason: diagnostic, phase, ownerPhase: presentation.status.phase, ownerReason: presentation.status.reason };
    bridge.memoryAdmission = snapshot;
    return () => { if (bridge.memoryAdmission === snapshot) delete bridge.memoryAdmission; };
  }, [diagnostic, phase, presentation.status.phase, presentation.status.reason]);
  const setAnchor = useCallback((node: HTMLDivElement | null) => { contentFrame.current = node?.closest<HTMLElement>(".app-page-shell") ?? null; }, []);
  const owners = { commerce, sharing };
  return <>
    <div ref={setAnchor} hidden aria-hidden="true" />
    {typeof window !== "undefined" && window.__HUSHH_NATIVE_TEST__?.enabled === true &&
      <div role="progressbar" aria-label="native-memory-admission" aria-valuemin={0} aria-valuemax={1} aria-valuenow={0}
        aria-valuetext={`reason=${diagnostic};phase=${phase};ownerPhase=${presentation.status.phase};ownerReason=${presentation.status.reason}`}
        style={{ position: "fixed", left: 0, top: 0, width: 1, height: 1, opacity: 0.01, pointerEvents: "none" }} />}
    {phase === "web" && !presentation.status.held ? renderFallback(owners) : <NativeTestBeacon routeId={ROUTES.PKM}
      marker="native-route-pkm" authState={model.signedIn ? "authenticated" : model.authLoading ? "pending" : "anonymous"}
      dataState={model.nativeDataState} errorCode={model.nativeDataState === "error" ? "pkm_memory_unavailable" : null} />}
  </>;
}
