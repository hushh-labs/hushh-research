"use client";

import { Component, useCallback, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft } from "@/components/icons";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { openPersonPreviewHistory, closePersonPreviewHistory, personPreviewHistoryEntry } from "@/lib/navigation/profile-pane";
import { ConnectionsService } from "@/lib/services/connections-service";
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { PERSON_PROFILE_PREVIEW_EVENT, type PersonProfilePreviewIdentity } from "@/lib/connections/person-profile-preview";
import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";

const Profile = lazy(() => import("./person-profile-page").then(module => ({ default: module.PersonProfilePage })));

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
  const [entry, setEntry] = useState<(PersonProfilePreviewIdentity & { returnFocus?: HTMLElement; owner: string; generation: number | null; route: string; key: number }) | null>(null);
  const [resolved, setResolved] = useState<{ key: number; personRef: string | null } | null>(null);
  const nextKey = useRef(0);
  const opening = useRef(false);
  const returnFocus = useRef<HTMLElement | undefined>(undefined);
  const route = `${pathname}?${search}`;
  const active = entry && entry.owner === user?.uid && entry.generation === getAuthSessionGeneration() && entry.route === route ? entry : null;

  const close = useCallback(() => {
    if (entry && closePersonPreviewHistory(entry.key)) return;
    setEntry(null);
  }, [entry]);

  useLayoutEffect(() => {
    opening.current = Boolean(active);
    if (!active) return;
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
      if (entry && personPreviewHistoryEntry(window.history.state) !== entry.key) setEntry(null);
    };
    window.addEventListener("popstate", popped);
    return () => window.removeEventListener("popstate", popped);
  }, [entry]);

  usePublishVoiceSurfaceMetadata(active ? { interactionLayer: {
    schemaVersion: "voice_interaction_layer.v1", id: "person_profile_preview", kind: "person_profile",
    modality: "modal", lifecycle: "open", dismissible: true, dismissActionId: null,
    visibleActionIds: [], visibleControlIds: [], options: [],
    blocksUnderlyingActions: true, agentContinuity: "suppressed",
  } } : null, { role: "interaction_layer" });

  useEffect(() => { if (entry && !active) setEntry(null); }, [entry, active]);

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<PersonProfilePreviewIdentity & { returnFocus?: HTMLElement }>).detail;
      if (!user || opening.current || (!detail?.personRef?.trim() && !detail?.userId?.trim())) return;
      opening.current = true;
      returnFocus.current = detail.returnFocus;
      const key = ++nextKey.current;
      openPersonPreviewHistory(key);
      setEntry({ ...detail, owner: user.uid, generation: getAuthSessionGeneration(), route, key });
    };
    window.addEventListener(PERSON_PROFILE_PREVIEW_EVENT, open);
    return () => window.removeEventListener(PERSON_PROFILE_PREVIEW_EVENT, open);
  }, [user, route]);

  useEffect(() => {
    if (!active || active.personRef?.trim() || !user) return;
    let cancelled = false;
    const key = active.key;
    void user.getIdToken().then(idToken => ConnectionsService.getPersonContext({ idToken, counterpartUserId: active.userId!.trim() }))
      .then(context => { if (!cancelled) setResolved({ key, personRef: context.person.publicPersonRef?.trim() || null }); })
      .catch(() => { if (!cancelled) setResolved({ key, personRef: null }); });
    return () => { cancelled = true; };
  }, [active, user]);

  const personRef = active?.personRef?.trim() || (resolved?.key === active?.key ? resolved?.personRef : null);
  return <Dialog modal open={Boolean(active)} onOpenChange={open => { if (!open) close(); }}>
    <DialogContent data-person-profile-preview aria-label="Person profile" showCloseButton={false}
      className="!w-full !max-w-[880px] !gap-0 !p-0"
      onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); }}>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-3 py-2">
        <button type="button" aria-label="Back to previous screen" className="flex size-11 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-ring" onClick={close}><ArrowLeft className="size-5" /></button>
        <DialogTitle>Profile</DialogTitle>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain py-4">
        {active && personRef ? <PreviewBoundary key={active.key}><Suspense fallback={<p role="status" className="p-6">Loading profile…</p>}><Profile key={`${active.key}:${personRef}`} personRef={personRef} initialProfile={null} embedded /></Suspense></PreviewBoundary>
          : <p role={resolved?.key === active?.key ? "alert" : "status"} className="p-6">{resolved?.key === active?.key ? "This profile is unavailable." : "Loading profile…"}</p>}
      </div>
    </DialogContent>
  </Dialog>;
}
