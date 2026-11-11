"use client";

import { Component, useCallback, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft } from "@/components/icons";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { openPersonPreviewHistory, closePersonPreviewHistory, personPreviewHistoryEntry } from "@/lib/navigation/profile-pane";
import { ConnectionsService } from "@/lib/services/connections-service";
import { getAuthSessionGeneration, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { PERSON_PROFILE_PREVIEW_EVENT, type PersonProfilePreviewIdentity } from "@/lib/connections/person-profile-preview";
import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { useBackLayer } from "@/lib/navigation/back-layers";
import calendarPresentation from "@/components/calendar/calendar-presentation.module.css";
import { cn } from "@/lib/utils";

const Profile = lazy(() => import("./person-profile-page").then(module => ({ default: module.PersonProfilePage })));
const NetworkList = lazy(() => import("../connect/network-people-list").then(module => ({ default: module.NetworkPeopleList })));
let nextJourneyKey = 0;
type Visit = PersonProfilePreviewIdentity & { owner: string; generation: number | null; route: string; key: number; scrollTop?: number; focus?: { control?: string; person?: string } };

class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert" className="p-6">This profile is unavailable.</p> : this.props.children; }
}

/** Keep the calling screen and its sheets mounted, including selections and scroll. */
export function PersonProfilePreview() {
  const { user } = useAuth();
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? "";
  const [entry, setEntry] = useState<Visit | null>(null);
  const [resolved, setResolved] = useState<{ key: number; personRef: string | null } | null>(null);
  // Bounded, per-host memory restores known Forward entries; history itself has
  // only opaque counters. A cold reload deliberately starts from the route.
  const visits = useRef(new Map<number, Visit>());
  const opening = useRef(false);
  const closing = useRef(false);
  const returnFocus = useRef<HTMLElement | undefined>(undefined);
  const scroll = useRef<HTMLDivElement>(null);
  const currentEntry = useRef(entry);
  currentEntry.current = entry;
  const restoredKey = useRef<number | null>(null);
  const route = `${pathname}?${search}`;
  const active = entry && entry.owner === user?.uid && entry.generation === getAuthSessionGeneration() && entry.route === route ? entry : null;
  useEffect(() => subscribeAuthSessionGeneration(() => {
    visits.current.clear(); setEntry(null); setResolved(null);
    opening.current = false; closing.current = false;
  }), []);
  const rememberVisit = useCallback((focusOverride?: HTMLElement) => {
    const visit = currentEntry.current;
    if (!visit) return;
    visit.scrollTop = scroll.current?.scrollTop ?? 0;
    const focused = focusOverride ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (focused && scroll.current?.contains(focused)) {
      visit.focus = { control: focused.dataset.voiceControlId, person: focused.dataset.networkPerson };
    }
  }, []);
  const restoreVisit = useCallback(() => {
    const visit = currentEntry.current;
    if (!visit || restoredKey.current === visit.key || !scroll.current) return;
    scroll.current.scrollTop = visit.scrollTop ?? 0;
    const target = Array.from(scroll.current.querySelectorAll<HTMLElement>("[data-voice-control-id], button[data-network-person]"))
      .find(element => visit.focus?.control ? element.dataset.voiceControlId === visit.focus.control : visit.focus?.person ? element.dataset.networkPerson === visit.focus.person : false);
    target?.focus({ preventScroll: true });
    restoredKey.current = visit.key;
  }, []);
  useLayoutEffect(() => {
    restoredKey.current = null;
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [active?.key]);

  const close = useCallback(() => {
    if (closing.current) return;
    if (entry) {
      rememberVisit();
      closing.current = true;
      if (closePersonPreviewHistory(entry.key)) return;
      closing.current = false;
    }
    setEntry(null);
  }, [entry, rememberVisit]);
  useBackLayer(pathname ?? "", active ? 10 : 0, () => { close(); return true; });

  useLayoutEffect(() => {
    opening.current = Boolean(active);
    if (!active) { closing.current = false; return; }
    // Onboarding is an existing fullscreen takeover. Lift the standard dialog
    // layer only while viewing a person there, including nested request dialogs.
    const takeover = document.querySelector<HTMLElement>('[data-one-onboarding-design="location-agent-v3"]');
    if (!takeover) return;
    const sourceLayer = Number(getComputedStyle(takeover).zIndex);
    const body = document.body;
    const original = ["--z-dialog-overlay", "--z-dialog"].map(name => [name, body.style.getPropertyValue(name)] as const);
    if (!Number.isFinite(sourceLayer) || sourceLayer < 800) return;
    body.style.setProperty("--z-dialog-overlay", String(sourceLayer + 1));
    body.style.setProperty("--z-dialog", String(sourceLayer + 2));
    return () => { original.forEach(([name, value]) => { if (value) body.style.setProperty(name, value); else body.style.removeProperty(name); }); };
  }, [active]);

  useEffect(() => {
    const popped = () => {
      rememberVisit();
      const key = personPreviewHistoryEntry(window.history.state);
      const visit = key ? visits.current.get(key) : null;
      closing.current = false;
      setEntry(visit && visit.owner === user?.uid && visit.generation === getAuthSessionGeneration() && visit.route === route ? visit : null);
    };
    window.addEventListener("popstate", popped);
    return () => window.removeEventListener("popstate", popped);
  }, [user, route, rememberVisit]);

  usePublishVoiceSurfaceMetadata(active ? { interactionLayer: {
    schemaVersion: "voice_interaction_layer.v1", id: "person_profile_preview", kind: "person_profile",
    modality: "modal", lifecycle: "open", dismissible: true, dismissActionId: null,
    visibleActionIds: [], visibleControlIds: [], options: [],
    blocksUnderlyingActions: true, agentContinuity: "suppressed",
  } } : null, { role: "interaction_layer" });

  useEffect(() => {
    if (entry && !active) setEntry(null);
    for (const [key, visit] of visits.current) {
      if (visit.owner !== user?.uid || visit.generation !== getAuthSessionGeneration() || visit.route !== route) visits.current.delete(key);
    }
  }, [entry, active, user, route]);

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<PersonProfilePreviewIdentity & { returnFocus?: HTMLElement }>).detail;
      if (!user || (!detail?.personRef?.trim() && !detail?.userId?.trim() && detail?.networkList !== "discovery")) return;
      event.preventDefault();
      if (closing.current) return;
      rememberVisit(detail.returnFocus);
      if (!opening.current) returnFocus.current = detail.returnFocus;
      opening.current = true;
      const key = ++nextJourneyKey;
      const fromPreview = detail.returnFocus && scroll.current?.contains(detail.returnFocus);
      const presentation = detail.presentation ?? (fromPreview ? currentEntry.current?.presentation : undefined);
      const visit: Visit = { personRef: detail.personRef, userId: detail.userId, networkList: detail.networkList,
        presentation, owner: user.uid, generation: getAuthSessionGeneration(), route, key };
      visits.current.set(key, visit);
      if (visits.current.size > 64) visits.current.delete(visits.current.keys().next().value!);
      openPersonPreviewHistory(key);
      setEntry(visit);
    };
    window.addEventListener(PERSON_PROFILE_PREVIEW_EVENT, open);
    return () => window.removeEventListener(PERSON_PROFILE_PREVIEW_EVENT, open);
  }, [user, route, rememberVisit]);

  useEffect(() => {
    if (!active || active.networkList || active.personRef?.trim() || !user) return;
    let cancelled = false;
    const key = active.key;
    void user.getIdToken().then(idToken => ConnectionsService.getPersonContext({ idToken, counterpartUserId: active.userId!.trim() }))
      .then(context => { if (!cancelled) setResolved({ key, personRef: context.person.publicPersonRef?.trim() || null }); })
      .catch(() => { if (!cancelled) setResolved({ key, personRef: null }); });
    return () => { cancelled = true; };
  }, [active, user]);

  const personRef = active?.personRef?.trim() || (resolved?.key === active?.key ? resolved?.personRef : null);
  const networkMode = active?.networkList;
  const calendar = active?.presentation === "calendar";
  const title = networkMode === "discovery" ? "Your network" : networkMode === "mutuals" ? "Mutual connections" : networkMode === "connections" ? "Connections" : "Profile";
  return <Dialog modal open={Boolean(active)} onOpenChange={open => { if (!open) close(); }}>
    <DialogContent data-person-profile-preview data-connect-type-scale={calendar ? "page" : undefined} aria-label={networkMode ? title : "Person profile"} showCloseButton={false}
      className={cn(calendar && calendarPresentation.portal, networkMode
        ? "!w-[calc(100%-1rem)] !max-w-[760px] !gap-0 !overflow-hidden !p-0 sm:!w-[calc(100%-2rem)]"
        : "!w-full !max-w-[880px] !gap-0 !p-0")}
      onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); }}>
      <div className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2">
        <button type="button" aria-label="Back to previous screen" className="flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-ring" onClick={close}><ArrowLeft className="size-5" /></button>
        <DialogTitle>{title}</DialogTitle>
      </div>
      <div ref={scroll} data-network-scroll-owner className="min-h-0 overflow-y-auto overscroll-contain py-4">
        {active?.networkList ? <PreviewBoundary key={active.key}><Suspense fallback={<p role="status" className="p-6">Loading connections…</p>}><NetworkList key={active.key} mode={active.networkList} personRef={active.personRef ?? undefined} visitKey={`journey:${active.key}`} embedded onReady={restoreVisit} /></Suspense></PreviewBoundary>
          : active && personRef ? <PreviewBoundary key={active.key}><Suspense fallback={<p role="status" className="p-6">Loading profile…</p>}><Profile key={`${active.key}:${personRef}`} personRef={personRef} initialProfile={null} embedded calendarPresentation={calendar} onNetworkReady={restoreVisit} /></Suspense></PreviewBoundary>
          : <p role={resolved?.key === active?.key ? "alert" : "status"} className="p-6">{resolved?.key === active?.key ? "This profile is unavailable." : "Loading profile…"}</p>}
      </div>
    </DialogContent>
  </Dialog>;
}
