"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { LocationChatActionCard } from "./location-chat-action-card";
import { chatLocationPermissionIssue, LocationChatPermissionRecovery, type ChatLocationPermissionIssue } from "./location-chat-permission";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
import { subscribeToOneLocationStateChanges } from "@/lib/one-location/one-location-state-events";
import { publicInviteUrlLabel } from "@/lib/one-location/public-invite-url";
import { OneLocationService } from "@/lib/one-location/service";
import { locationDurationReply, locationReviewDecision } from "@/lib/agent/main-chat-location-conversation";
import { formatLocationDurationLabel } from "@/lib/one-location/duration-copy";
import { useLocationConversationTurn, type LocationConversationProps } from "./use-location-conversation-turn";
import type { OneLocationPublicInvite, OneLocationState, PlainLocationPoint } from "@/lib/one-location/types";

const PUBLIC_MINUTES = [15, 30, 60, 120];

function activeLink(state: OneLocationState, ownerId: string) {
  return state.publicInvites?.find((entry) => entry.ownerUserId === ownerId && entry.status === "active" &&
    Boolean(entry.expiresAt && Date.parse(entry.expiresAt) > Date.now())) ?? null;
}

export function LocationChatPublicShare({ token, ownerId, initialHours, loadState, capture, renderPoint, messageForError, onChanged, onBack, onDurationChange, onConversationText, onConversationReply }: {
  token: string;
  ownerId: string;
  initialHours?: number;
  loadState: () => Promise<OneLocationState>;
  capture: () => Promise<PlainLocationPoint>;
  renderPoint: (point: PlainLocationPoint) => ReactNode;
  messageForError: (error: unknown) => string;
  onChanged: () => void;
  onBack: () => void;
  onDurationChange?: (minutes: number) => void;
} & LocationConversationProps) {
  const now = useCoarseClock(15_000);
  const [invite, setInvite] = useState<OneLocationPublicInvite | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [point, setPoint] = useState<PlainLocationPoint | null>(null);
  const [minutes, setMinutes] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [permissionIssue, setPermissionIssue] = useState<ChatLocationPermissionIssue>(null);
  const [feedback, setFeedback] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
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
    setPermissionIssue(null);
    const version = runVersion.current;
    const isCurrent = () => version === runVersion.current;
    try { await effect(isCurrent); }
    catch (caught) {
      if (!isCurrent()) return;
      setError(messageForError(caught));
      setPermissionIssue(chatLocationPermissionIssue(caught));
    }
    finally {
      inFlight.current = false;
      if (isCurrent()) setBusy(false);
    }
  }

  const active = invite?.status === "active" && Boolean(invite.expiresAt && Date.parse(invite.expiresAt) > now);
  async function publish(location: PlainLocationPoint, durationMinutes: number, isCurrent: () => boolean) {
    if (!isCurrent()) return;
    const existing = activeLink(await loadState(), ownerId);
    if (!isCurrent()) return;
    if (existing) { setInvite(existing); setPoint(null); return; }
    const capturedAt = Date.parse(location.capturedAt);
    if (!Number.isFinite(capturedAt) || Math.abs(Date.now() - capturedAt) > 55_000) {
      setPoint(null);
      throw new Error("The location is out of date. Ask me for a fresh link.");
    }
    const created = await OneLocationService.createPublicInvite({
      vaultOwnerToken: token, durationHours: durationMinutes / 60, locationSnapshot: location,
    });
    onChanged();
    if (!isCurrent()) return;
    setInvite({ ...created.invite, publicUrl: created.publicUrl });
    setPoint(null);
  }
  const hours = minutes === undefined ? initialHours : minutes / 60;
  const validHours = hours !== undefined && hours >= 0.25 && hours <= 2;
  const text = cancelled ? "Cancelled." : active ? "Your public location link is active. Anyone with the link can see your location until it expires."
    : error ? error : busy ? "Preparing your public location link…" : !loaded ? "Checking your public links…"
      : validHours ? `Create a public link to your location for ${formatLocationDurationLabel(hours)}? Anyone who has it can see your location. Reply yes to create it.`
        : "How long should the public link last? Choose between 15 minutes and 2 hours.";
  useLocationConversationTurn({ onConversationReply, onConversationText }, text, (reply) => {
    if (!loaded || active || cancelled || busy || inFlight.current) return false;
    const decision = locationReviewDecision(reply);
    if (decision === "cancel") { setCancelled(true); return true; }
    const requested = locationDurationReply(reply);
    if (requested !== undefined && requested <= 2) {
      setMinutes(requested * 60);
      onDurationChange?.(requested * 60);
      setError(undefined);
      return true;
    }
    if (!validHours || decision !== "confirm" || error) return false;
    void run(async (current) => publish(await capture(), hours * 60, current));
    return true;
  });
  if (onConversationText) {
    // A public bearer link belongs on the unlocked device, outside transcript and model memory.
    const url = active && invite?.publicUrl ? publicInviteUrlLabel(invite.publicUrl) : "";
    return <>{url ? <a className="text-sm text-primary underline" href={url} target="_blank" rel="noreferrer">Open your location link</a> : null}
      {permissionIssue ? <LocationChatPermissionRecovery issue={permissionIssue} /> : null}</>;
  }
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
  return <><LocationChatActionCard model={{
    phase: "review", title: "Public location link", mode: "live",
    description: feedback ?? "Anyone with the link can see your live location until it expires. You can stop sharing at any time.",
    dismissLabel: "Back", confirmLabel: point ? "Create public link" : "Preview location",
    ...(point && minutes ? { facts: [{ label: "Duration", value: `${minutes} minutes` }] } : {
      duration: { kind: "duration" as const, minutes: validDefault, options: [...new Set([...PUBLIC_MINUTES, validDefault])].sort((a, b) => a - b) },
    }), error,
  }} busy={busy} onDismiss={onBack} map={point ? renderPoint(point) : undefined} onConfirm={(input, event) => {
    if (!event.nativeEvent.isTrusted) return;
    void run(async (isCurrent) => {
      if (!point) {
        const requestedMinutes = input.durationMinutes ?? validDefault;
        onDurationChange?.(requestedMinutes);
        const position = await capture();
        if (isCurrent()) { setMinutes(requestedMinutes); setPoint(position); }
        return;
      }
      await publish(point, minutes ?? validDefault, isCurrent);
    });
  }} /><LocationChatPermissionRecovery issue={permissionIssue} /></>;
}
