"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { LocationChatActionCard } from "./location-chat-action-card";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
import { subscribeToOneLocationStateChanges } from "@/lib/one-location/one-location-state-events";
import { publicInviteUrlLabel } from "@/lib/one-location/public-invite-url";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationPublicInvite, OneLocationState, PlainLocationPoint } from "@/lib/one-location/types";

const PUBLIC_MINUTES = [15, 30, 60, 120];

function activeLink(state: OneLocationState, ownerId: string) {
  return state.publicInvites?.find((entry) => entry.ownerUserId === ownerId && entry.status === "active" &&
    Boolean(entry.expiresAt && Date.parse(entry.expiresAt) > Date.now())) ?? null;
}

export function LocationChatPublicShare({ token, ownerId, initialHours, loadState, capture, renderPoint, messageForError, onChanged, onBack }: {
  token: string;
  ownerId: string;
  initialHours?: number;
  loadState: () => Promise<OneLocationState>;
  capture: () => Promise<PlainLocationPoint>;
  renderPoint: (point: PlainLocationPoint) => ReactNode;
  messageForError: (error: unknown) => string;
  onChanged: () => void;
  onBack: () => void;
}) {
  const now = useCoarseClock(15_000);
  const [invite, setInvite] = useState<OneLocationPublicInvite | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [point, setPoint] = useState<PlainLocationPoint | null>(null);
  const [minutes, setMinutes] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const inFlight = useRef(false);
  const runVersion = useRef(0);

  useEffect(() => {
    let current = true;
    const refresh = () => {
      void loadState().then((state) => {
        if (!current) return;
        setInvite(activeLink(state, ownerId));
        setLoaded(true);
      }).catch(() => {
        if (current) setError("Couldn’t load your public links. Try again.");
      });
    };
    refresh();
    const unsubscribe = subscribeToOneLocationStateChanges((event) => {
      if (event.userId === ownerId) refresh();
    });
    window.addEventListener("focus", refresh);
    return () => {
      current = false;
      runVersion.current += 1;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [loadState, ownerId]);

  async function run(effect: (isCurrent: () => boolean) => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    const version = runVersion.current;
    const isCurrent = () => version === runVersion.current;
    try { await effect(isCurrent); }
    catch (caught) { if (isCurrent()) setError(messageForError(caught)); }
    finally {
      inFlight.current = false;
      if (isCurrent()) setBusy(false);
    }
  }

  const active = invite?.status === "active" && Boolean(invite.expiresAt && Date.parse(invite.expiresAt) > now);
  if (active && invite) {
    const url = invite.publicUrl ? publicInviteUrlLabel(invite.publicUrl) : "";
    return <LocationChatActionCard model={{
      phase: "active", title: "Public location link", endAt: invite.expiresAt, status: feedback ?? "Anyone with the link can see this location",
      actions: url ? [
        { id: "copy", label: "Copy link" },
        ...(typeof navigator.share === "function" ? [{ id: "share", label: "Share link", variant: "primary" as const }] : []),
      ] : [], canStop: true, error,
    }} busy={busy} onRecover={(action, event) => {
      if (!event.nativeEvent.isTrusted || !url) return;
      void run(async (isCurrent) => {
        if (action === "share") {
          try { await navigator.share({ title: "My location", url }); }
          catch (caught) { if (!(caught instanceof DOMException && caught.name === "AbortError")) throw caught; }
        } else {
          await navigator.clipboard.writeText(url);
          if (isCurrent()) setFeedback("Link copied");
        }
      });
    }} onStop={(event) => {
      if (!event.nativeEvent.isTrusted) return;
      void run(async (isCurrent) => {
        await OneLocationService.revokePublicInvite({ vaultOwnerToken: token, inviteId: invite.id });
        onChanged();
        if (!isCurrent()) return;
        setInvite(null);
        setFeedback("Public link stopped");
      });
    }} />;
  }
  if (!loaded) return <LocationChatActionCard model={{
    phase: "recovery", title: "Public location link", description: error ?? "Checking your public links…",
    actions: error ? [{ id: "retry", label: "Try again", variant: "primary" }, { id: "back", label: "Back" }] : [],
  }} busy={busy} onRecover={(action) => {
    if (action === "back") { onBack(); return; }
    void run(async (isCurrent) => {
      const state = await loadState();
      if (isCurrent()) { setInvite(activeLink(state, ownerId)); setLoaded(true); }
    });
  }} />;
  const defaultMinutes = initialHours ? Math.round(initialHours * 60) : 60;
  const validDefault = defaultMinutes >= 15 && defaultMinutes <= 120 ? defaultMinutes : 60;
  return <LocationChatActionCard model={{
    phase: "review", title: "Public location link", mode: "current",
    description: feedback ?? "Anyone with the link can see this location until it expires. You can stop access at any time.",
    dismissLabel: "Back", confirmLabel: point ? "Create public link" : "Preview current location",
    ...(point && minutes ? { facts: [{ label: "Duration", value: `${minutes} minutes` }] } : {
      duration: { kind: "duration" as const, minutes: validDefault, options: [...new Set([...PUBLIC_MINUTES, validDefault])].sort((a, b) => a - b) },
    }), error,
  }} busy={busy} onDismiss={onBack} map={point ? renderPoint(point) : undefined} onConfirm={(input, event) => {
    if (!event.nativeEvent.isTrusted) return;
    void run(async (isCurrent) => {
      if (!point) {
        const position = await capture();
        if (isCurrent()) { setMinutes(input.durationMinutes ?? validDefault); setPoint(position); }
        return;
      }
      if (Date.now() - Date.parse(point.capturedAt) > 55_000) {
        setPoint(null);
        throw new Error("The preview is out of date. Capture a new position to continue.");
      }
      const existing = activeLink(await loadState(), ownerId);
      if (!isCurrent()) return;
      if (existing) { setInvite(existing); setPoint(null); return; }
      const created = await OneLocationService.createPublicInvite({
        vaultOwnerToken: token, durationHours: (minutes ?? validDefault) / 60, locationSnapshot: point,
      });
      onChanged();
      if (!isCurrent()) return;
      setInvite({ ...created.invite, publicUrl: created.publicUrl });
      setPoint(null);
    });
  }} />;
}
