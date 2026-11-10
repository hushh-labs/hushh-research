"use client";

import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { usePathname } from "next/navigation";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { PkmNaturalPanelBody } from "@/components/profile/pkm-natural-panel";
import { usePkmNaturalModel } from "@/components/profile/use-pkm-natural-model";
import { useNativeWorkspace, useNativeWorkspacePresentation, type NativeWorkspaceContent } from "@/lib/capacitor/use-native-workspace";
import { useNativeWorkspaceHandoff } from "@/lib/capacitor/use-native-workspace-handoff";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { nativePrivacyCanInteract, nativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { normalizeStaticExportPathname, ROUTES } from "@/lib/navigation/routes";
import { pkmMemoryRowLabels } from "@/lib/pkm/pkm-memory-cards";

/** Recently learned keeps its original Memory model. The shared workspace
 * owns the native list; rich detail opens only after exact retirement. */
export function NativeRecentMemory() {
  const model = usePkmNaturalModel({ view: "recent" });
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const nativeRequested = customNativePresentationEnabled();
  const presentation = useNativeWorkspacePresentation();
  const contentFrame = useRef<HTMLElement | null>(null);
  const { handoff, activationRevision, intent } = useNativeWorkspaceHandoff(presentation.retireForWeb, model.presentationIdentity);
  const latest = useRef({ model, pathname });
  useLayoutEffect(() => { latest.current = { model, pathname }; });
  const handle = useMemo(() => {
    const values = new Map<string, string>();
    return (key: string) => {
      let value = values.get(key);
      if (!value) { value = crypto.randomUUID(); values.set(key, value); }
      return value;
    };
  }, [model.ownerId]);
  const routeCurrent = () => latest.current.pathname === ROUTES.PKM_RECENT &&
    latest.current.model.ownerId === model.ownerId && latest.current.model.presentationIdentity === model.presentationIdentity &&
    latest.current.model.captureSessionCurrent() &&
    nativePrivacyCanInteract(nativePrivacyObservation().state);
  const rows = nativeRequested ? model.recentMemories.map(card => ({ card, labels: pkmMemoryRowLabels(card) })) : [];
  const representable = rows.length <= 200 && new Set(rows.map(({ card }) => card.id)).size === rows.length && rows.every(({ labels }) => labels.primary.length > 0 &&
    labels.primary.length <= 4096 && labels.secondary.length <= 4096);
  const eligible = nativeRequested && pathname === ROUTES.PKM_RECENT && !model.authLoading && model.canOpen &&
    !model.selectedCard && representable;
  const active = eligible && model.captureSessionCurrent();
  const actions = new Map<string, () => Promise<void>>();
  const list = representable ? rows.map(({ card, labels }, index) => {
    const id = handle(`recent:${index}:${card.id}`);
    actions.set(id, async () => {
      let currentCard: typeof card | undefined;
      await handoff(routeCurrent, () => {
        currentCard = latest.current.model.recentMemories.find(item => item.id === card.id);
        return !!currentCard;
      }, () => {
        const requested = intent.current;
        latest.current.model.openMemory(currentCard!);
        if (currentCard!.domain !== "location") requestAnimationFrame(() => {
          if (requested === intent.current && routeCurrent()) {
            document.querySelector<HTMLElement>('[data-app-scroll-root="true"]')?.scrollTo?.({ top: 0, behavior: "instant" });
          }
        });
      });
    });
    return { id, label: labels.primary, ...(labels.secondary ? { detail: labels.secondary } : {}), enabled: true, chevron: true };
  }) : [];
  const content: NativeWorkspaceContent = {
    workspace: "memory", page: "overview", title: "Recently learned", enabled: active, backEnabled: false,
    sections: nativeRequested ? [{ id: handle("recent-list"), rows: list.length ? list : [{ id: handle("recent-empty"), label: "Nothing learned yet.", enabled: false, readOnly: true }] }] : [],
  };
  const phase = useNativeWorkspace({ owner: model.ownerId, content, actions, current: routeCurrent,
    back: () => {}, active, presentationOwner: presentation.owner, contentFrame, activationRevision });
  const setAnchor = useCallback((node: HTMLDivElement | null) => {
    contentFrame.current = node?.closest<HTMLElement>(".app-page-shell") ?? null;
  }, []);
  // When a rich child closes, avoid flashing the web list before the shared
  // owner can re-admit native. Genuine capability/presentation failure still
  // exposes the complete established fallback after confirmed retirement.
  const admissionPending = eligible && phase === "web" && presentation.status.reason !== "unsupported" && presentation.status.reason !== "failure";
  return <>
    <div ref={setAnchor} hidden aria-hidden="true" />
    {phase === "web" && !presentation.status.held && !admissionPending ? <PkmNaturalPanelBody model={model} view="recent" locationMemoryId={null} /> : <>
      <NativeTestBeacon routeId={ROUTES.PKM_RECENT} marker="native-route-pkm-recent"
        authState={model.signedIn ? "authenticated" : model.authLoading ? "pending" : "anonymous"}
        dataState={model.nativeDataState} errorCode={model.nativeDataState === "error" ? "pkm_memory_unavailable" : null} />
      {!presentation.status.held && (phase === "checking" || admissionPending) && <p role="status">Opening Memory…</p>}
    </>}
  </>;
}
