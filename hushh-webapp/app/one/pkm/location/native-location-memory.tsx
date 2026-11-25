"use client";

import { useNativeWorkspaceEvent, createNativeWorkspaceHandles, useNativeWorkspaceHandoff } from "@/lib/capacitor/use-native-workspace-handoff";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { PkmNaturalPanelBody } from "@/components/profile/pkm-natural-panel";
import { usePkmNaturalModel } from "@/components/profile/use-pkm-natural-model";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { nativePrivacyCanInteract, nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import type { NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import { useNativeWorkspace, useNativeWorkspacePresentation, type NativeWorkspaceContent } from "@/lib/capacitor/use-native-workspace";

import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import { normalizeStaticExportPathname, ROUTES } from "@/lib/navigation/routes";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

/** The existing Location model owns the data and navigation. Native displays
 * its bounded list; the complete authored detail remains the web child. */
export function NativeLocationMemory() {
  const model = usePkmNaturalModel({ view: "location" });
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const nativeRequested = customNativePresentationEnabled();
  const presentation = useNativeWorkspacePresentation();
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const vaultEpoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const [query, setQuery] = useState("");
  const [child, setChild] = useState<{ seen: boolean } | null>(null);
  const { handoff, activationRevision, intent: intentRef } = useNativeWorkspaceHandoff(presentation.retireForWeb, model.presentationIdentity);
  const contentFrame = useRef<HTMLElement | null>(null);
  const latest = useRef({ model, pathname, query });
  useLayoutEffect(() => { latest.current = { model, pathname, query }; });
  useLayoutEffect(() => { setChild(null); }, [model.presentationIdentity]);
  useLayoutEffect(() => { setQuery(""); intentRef.current += 1; }, [model.ownerId, model.canOpen, model.sessionVerificationRequired, privacy?.generation, vaultEpoch, intentRef]);
  useLayoutEffect(() => {
    if (!child) return;
    if (pathname !== ROUTES.PKM_LOCATION && !child.seen) setChild({ seen: true });
    else if (pathname === ROUTES.PKM_LOCATION && child.seen) setChild(null);
  }, [child, pathname]);
  const handle = useMemo(() => createNativeWorkspaceHandles(String(model.ownerId)), [model.ownerId]);
  const routeCurrent = () => latest.current.pathname === ROUTES.PKM_LOCATION &&
    latest.current.model.ownerId === model.ownerId && latest.current.model.presentationIdentity === model.presentationIdentity &&
    latest.current.model.captureSessionCurrent() &&
    nativePrivacyCanInteract(nativePrivacyObservation().state);
  const search = query.trim().toLocaleLowerCase();
  const source = nativeRequested && model.canOpen ? model.locationPresentation : null;
  const filtered = source?.sections.filter(section => !search ||
    `${section.title} ${section.fields.map(field => `${field.label} ${field.value}`).join(" ")}`.toLocaleLowerCase().includes(search)) ?? [];
  const count = filtered.reduce((total, section) => total + section.fields.length, 0);
  const extraSections = (filtered.length === 0 ? 1 : 0) + (source?.incomplete ? 1 : 0);
  const representable = !!source && query.length <= 256 && filtered.length + extraSections <= 32 &&
    count + extraSections <= 200 && filtered.every(section => section.title.length > 0 && section.title.length <= 256 &&
      section.fields.every(field => field.label.length > 0 && field.label.length <= 4096 && field.value.length > 0 && field.value.length <= 4096));
  const eligible = nativeRequested && pathname === ROUTES.PKM_LOCATION && model.canOpen && !model.authLoading &&
    !model.sessionVerificationRequired && !model.locationLoading && !model.bootstrapError && !model.domainDetail.error &&
    representable && !child;
  const active = eligible && model.captureSessionCurrent();
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<void>>();
  const openField = useNativeWorkspaceEvent(async (field: (typeof filtered)[number]["fields"][number]) => {
          let selector: string | undefined;
          await handoff(routeCurrent, () => {
            const current = latest.current;
            const matches = current.model.locationPresentation.sections.flatMap(item => item.fields).filter(item =>
              item.selector === field.selector && item.card.valueFingerprint === field.card.valueFingerprint &&
              JSON.stringify(item.card.pathSegments) === JSON.stringify(field.card.pathSegments));
            selector = matches[0]?.selector ?? undefined;
            return current.query === query && matches.length === 1;
          }, () => {
            setChild({ seen: false });
            latest.current.model.navigate(`${ROUTES.PKM_LOCATION_DETAIL}?memory=${selector}`);
          });
        });
  const sections: NativeDrawerSection[] = [];
  if (representable && source) {
    filtered.forEach((section, sectionIndex) => {
      sections.push({ id: handle(`section:${sectionIndex}:${section.key}`), title: section.title, rows: section.fields.map((field, fieldIndex) => {
        const id = handle(`field:${sectionIndex}:${fieldIndex}:${section.key}`);
        if (field.selector) actions.set(id, () => openField(field));
        return { id, label: field.label, detail: field.value, enabled: !!field.selector, chevron: !!field.selector, readOnly: !field.selector };
      }) });
    });
    if (!filtered.length) sections.push({ id: handle("empty"), rows: [{ id: handle("empty-row"),
      label: search ? "No location details match your search." : "No location details saved yet.", enabled: false, readOnly: true }] });
    if (source.incomplete) sections.push({ id: handle("incomplete"), rows: [{ id: handle("incomplete-row"),
      label: "Some details couldn’t be displayed. Your saved memory is unchanged.", enabled: false, readOnly: true }] });
  }
  const searchId = nativeRequested && source ? handle("search") : "location-search";
  if (source) actions.set(searchId, choice => { if (choice.text !== undefined) setQuery(choice.text); });
  const content: NativeWorkspaceContent = { workspace: "memory", page: "overview", title: "Location memory", enabled: active,
    backEnabled: false, sections, ...(representable ? { search: { id: searchId, label: "Search Location memory", query, live: true, afterSection: 0 } } : {}) };
  const phase = useNativeWorkspace({ owner: model.ownerId, content, actions, current: routeCurrent, back: () => {}, active,
    presentationOwner: presentation.owner, contentFrame, activationRevision });
  const setAnchor = useCallback((node: HTMLDivElement | null) => {
    contentFrame.current = node?.closest<HTMLElement>(".app-page-shell") ?? null;
  }, []);
  const waitingForData = nativeRequested && pathname === ROUTES.PKM_LOCATION && model.canOpen && !model.authLoading &&
    !model.sessionVerificationRequired && model.locationLoading && !model.bootstrapError && !model.domainDetail.error && !child;
  const admissionPending = (eligible || waitingForData) && phase === "web" && presentation.status.reason !== "unsupported" && presentation.status.reason !== "failure";
  return <>
    <div ref={setAnchor} hidden aria-hidden="true" />
    {phase === "web" && !presentation.status.held && !admissionPending ?
      <PkmNaturalPanelBody model={model} view="location" locationMemoryId={null} locationSearch={{ query, setQuery }} /> : <>
        <NativeTestBeacon routeId={ROUTES.PKM_LOCATION} marker="native-route-pkm-location"
          authState={model.signedIn ? "authenticated" : model.authLoading ? "pending" : "anonymous"}
          dataState={model.nativeDataState} errorCode={model.nativeDataState === "error" ? "pkm_memory_unavailable" : null} />
        {!presentation.status.held && (phase === "checking" || admissionPending) && <p role="status">Opening Location memory…</p>}
      </>}
  </>;
}
