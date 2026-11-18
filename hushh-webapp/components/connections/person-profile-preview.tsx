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
import { discoveryNetworkPages, NetworkPageCache } from "@/lib/connect/network-page-cache";
import { subscribeToConnectionGraphChanges } from "@/lib/connections/connection-graph-events";
import { loadNetworkPreviewList, preloadedNetworkPreviewList, type NetworkListComponent } from "@/components/connect/network-preview-list-loader";

const loadProfile = () => import("./person-profile-page").then(module => ({ default: module.PersonProfilePage }));
const Profile = lazy(loadProfile);
const LazyNetworkList = lazy(loadNetworkPreviewList);
let nextJourneyKey = 0;
type Visit = PersonProfilePreviewIdentity & { owner: string; generation: number | null; route: string; key: number; journeyPages: NetworkPageCache; listPages?: NetworkPageCache; listComponent?: NetworkListComponent; resolvedRef?: string; scrollTop?: number; focus?: { control?: string; person?: string } };

class PreviewBoundary extends Component<{ children: ReactNode; unavailable: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert" className="text-sm text-muted-foreground">{this.props.unavailable}</p> : this.props.children; }
}

/** Keep the calling screen and its sheets mounted, including selections and scroll. */
export function PersonProfilePreview() {
  const { user, userId } = useAuth();
  const sessionOwner = userId ?? user?.uid;
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? "";
  const [entry, setEntry] = useState<Visit | null>(null);
  const [resolved, setResolved] = useState<{ key: number; personRef: string | null } | null>(null);
  // Bounded, per-host memory restores known Forward entries; history itself has
  // only opaque counters. A cold reload deliberately starts from the route.
  const visits = useRef(new Map<number, Visit>());
  const privatePages = useRef<NetworkPageCache | null>(null);
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
    privatePages.current?.clear();
    visits.current.clear(); setEntry(null); setResolved(null);
    opening.current = false; closing.current = false;
  }), []);
  useEffect(() => {
    const unsubscribe = subscribeToConnectionGraphChanges(event => {
      if (event.userId === sessionOwner) privatePages.current?.clear();
    });
    return () => { unsubscribe(); privatePages.current?.clear(); };
  }, [sessionOwner]);
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
    if (!active) {
      closing.current = false;
      privatePages.current?.clear();
      privatePages.current = null;
      return;
    }
    if (privatePages.current !== active.journeyPages) {
      privatePages.current?.clear();
      privatePages.current = active.journeyPages;
    }
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
      if (detail.networkList) void loadProfile().catch(() => {});
      rememberVisit(detail.returnFocus);
      if (!opening.current) returnFocus.current = detail.returnFocus;
      opening.current = true;
      const key = ++nextJourneyKey;
      const journeyPages = privatePages.current ?? new NetworkPageCache();
      privatePages.current = journeyPages;
      const visit: Visit = {
        personRef: detail.personRef, userId: detail.userId, networkList: detail.networkList,
        owner: user.uid, generation: getAuthSessionGeneration(), route, key, journeyPages,
        listPages: detail.networkList === "discovery" ? discoveryNetworkPages(sessionOwner ?? user.uid) : journeyPages,
        listComponent: preloadedNetworkPreviewList(),
      };
      visits.current.set(key, visit);
      if (visits.current.size > 64) visits.current.delete(visits.current.keys().next().value!);
      openPersonPreviewHistory(key);
      setEntry(visit);
    };
    window.addEventListener(PERSON_PROFILE_PREVIEW_EVENT, open);
    return () => window.removeEventListener(PERSON_PROFILE_PREVIEW_EVENT, open);
  }, [user, sessionOwner, route, rememberVisit]);

  useEffect(() => {
    if (!active || active.networkList || active.personRef?.trim() || active.resolvedRef || !user) return;
    let cancelled = false;
    const key = active.key;
    void user.getIdToken().then(idToken => ConnectionsService.getPersonContext({ idToken, counterpartUserId: active.userId!.trim() }))
      .then(context => {
        if (cancelled) return;
        const personRef = context.person.publicPersonRef?.trim() || null;
        if (personRef) active.resolvedRef = personRef;
        setResolved({ key, personRef });
      })
      .catch(() => { if (!cancelled) setResolved({ key, personRef: null }); });
    return () => { cancelled = true; };
  }, [active, user]);

  const personRef = active?.personRef?.trim() || active?.resolvedRef || (resolved?.key === active?.key ? resolved?.personRef : null);
  const networkMode = active?.networkList;
  const NetworkList = active?.listComponent ?? LazyNetworkList;
  const title = networkMode === "discovery" ? "Your network" : networkMode === "mutuals" ? "Mutual connections" : networkMode === "connections" ? "Connections" : "Profile";
  return <Dialog modal open={Boolean(active)} onOpenChange={open => { if (!open) close(); }}>
    {active ? <DialogContent data-person-profile-preview aria-label={networkMode ? title : "Person profile"} showCloseButton={false}
      className="!h-[min(42rem,calc(100dvh-2rem))] !w-[calc(100%-1rem)] !max-w-[880px] !gap-0 !overflow-hidden !p-0 [--preview-gutter:0.75rem] sm:!w-[calc(100%-2rem)] sm:[--preview-gutter:1.25rem]"
      onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); }}>
      <div className="flex shrink-0 items-center gap-2 border-b bg-background px-[var(--preview-gutter)] py-2">
        <button type="button" aria-label="Back to previous screen" className="flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-ring" onClick={close}><ArrowLeft aria-hidden="true" className="size-5 rtl:rotate-180" /></button>
        <DialogTitle>{title}</DialogTitle>
      </div>
      <div ref={scroll} data-network-scroll-owner className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-[var(--preview-gutter)] pt-3 pb-4 [scrollbar-gutter:stable] sm:pt-4 sm:pb-5">
        {active.networkList ? <PreviewBoundary key={active.key} unavailable="This connection list is unavailable."><Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Loading connections…</p>}><NetworkList key={active.key} mode={active.networkList} personRef={active.personRef ?? undefined} visitKey={`journey:${active.key}`} embedded retainedPages={active.listPages} onReady={restoreVisit} onDismiss={close} /></Suspense></PreviewBoundary>
          : personRef ? <PreviewBoundary key={active.key} unavailable="This profile is unavailable."><Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Loading profile…</p>}><Profile key={`${active.key}:${personRef}`} personRef={personRef} initialProfile={null} embedded onNetworkReady={restoreVisit} /></Suspense></PreviewBoundary>
          : <p role={resolved?.key === active.key ? "alert" : "status"} className="text-sm text-muted-foreground">{resolved?.key === active.key ? "This profile is unavailable." : "Loading profile…"}</p>}
      </div>
    </DialogContent> : null}
  </Dialog>;
}
