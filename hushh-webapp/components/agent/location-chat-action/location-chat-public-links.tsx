"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
import { subscribeToOneLocationStateChanges } from "@/lib/one-location/one-location-state-events";
import { publicInviteUrlLabel } from "@/lib/one-location/public-invite-url";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationPublicInvite, OneLocationState } from "@/lib/one-location/types";
import { LocationChatActionCard } from "./location-chat-action-card";

type Props = {
  token: string;
  ownerId: string;
  loadState: () => Promise<OneLocationState>;
  onChanged: () => void;
  onBack: () => void;
  onCreate: () => void;
};

function isActive(invite: OneLocationPublicInvite, now: number) {
  return invite.status === "active" && Boolean(invite.expiresAt && Date.parse(invite.expiresAt) > now);
}

export function LocationChatPublicLinks({ token, ownerId, loadState, onChanged, onBack, onCreate }: Props) {
  const now = useCoarseClock(15_000);
  const [links, setLinks] = useState<OneLocationPublicInvite[] | null>(null);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const identity = `${ownerId}:${token}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const generation = useRef(0);
  const operation = useRef(false);
  const refreshVersion = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++refreshVersion.current;
    try {
      const state = await loadState();
      if (currentIdentity.current !== identity || refreshVersion.current !== request) return;
      setLinks((state.publicInvites ?? []).filter((entry) => entry.ownerUserId === ownerId));
      setError(undefined);
    } catch {
      if (currentIdentity.current === identity && refreshVersion.current === request) {
        setError("Couldn’t load your public links. Try again.");
      }
    }
  }, [identity, loadState, ownerId]);

  useEffect(() => {
    setLinks(null);
    setFeedback(undefined);
    setError(undefined);
    setBusyId(null);
    void refresh();
    const unsubscribe = subscribeToOneLocationStateChanges((event) => {
      if (event.userId === ownerId) void refresh();
    });
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => {
      generation.current += 1;
      refreshVersion.current += 1;
      unsubscribe();
      window.removeEventListener("focus", focus);
    };
  }, [ownerId, refresh]);

  async function act(invite: OneLocationPublicInvite, action: string) {
    if (operation.current) return;
    operation.current = true;
    setBusyId(invite.id);
    setError(undefined);
    setFeedback(undefined);
    const started = generation.current;
    const current = () => currentIdentity.current === identity && generation.current === started;
    try {
      if (action === "stop") {
        const state = await OneLocationService.getState(token);
        if (!current()) return;
        const fresh = state.publicInvites?.find((entry) => entry.id === invite.id && entry.ownerUserId === ownerId);
        if (fresh && isActive(fresh, Date.now())) {
          await OneLocationService.revokePublicInvite({ vaultOwnerToken: token, inviteId: fresh.id });
          if (!current()) return;
          onChanged();
          setFeedback("Public link stopped");
        }
        await refresh();
        return;
      }
      if (!isActive(invite, Date.now()) || !invite.publicUrl) return;
      const url = publicInviteUrlLabel(invite.publicUrl);
      if (action === "copy") {
        await navigator.clipboard.writeText(url);
        if (current()) setFeedback("Link copied");
      } else {
        await navigator.share({ title: "My location", url });
      }
    } catch (caught) {
      if (current() && !(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(action === "stop" ? "Couldn’t stop this public link. Try again." : "Couldn’t share this link. Try again.");
      }
    } finally {
      operation.current = false;
      if (current()) setBusyId(null);
    }
  }

  const owned = links?.filter((entry) => entry.ownerUserId === ownerId) ?? [];
  return <section aria-label="Public location links" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button type="button" variant="ghost" disabled={busyId !== null} onClick={onBack}>Back</Button>
      <Button type="button" disabled={busyId !== null} onClick={onCreate}>Create public link</Button>
    </div>
    {error ? <div role="alert" className="space-y-2 text-sm text-destructive">
      <p>{error}</p><Button type="button" variant="outline" disabled={busyId !== null} onClick={() => { void refresh(); }}>Try again</Button>
    </div> : null}
    {feedback ? <p role="status" className="text-sm text-muted-foreground">{feedback}</p> : null}
    {links === null && !error ? <p role="status" className="text-sm text-muted-foreground">Loading public links…</p> : null}
    {links !== null && !owned.length ? <p className="text-sm text-muted-foreground">You haven’t created a public location link.</p> : null}
    {owned.map((invite) => {
      const active = isActive(invite, now);
      const canShare = active && Boolean(invite.publicUrl);
      return <LocationChatActionCard key={invite.id} model={{
        phase: active ? "active" : "result", title: "Public location link",
        status: active ? "Anyone with the link can see this location" : invite.status === "revoked" ? "Stopped" : "Expired",
        endAt: invite.expiresAt, canStop: active,
        actions: canShare ? [
          { id: "copy", label: "Copy link" },
          ...(typeof navigator.share === "function" ? [{ id: "share", label: "Share link", variant: "primary" as const }] : []),
        ] : [],
      }} busy={busyId !== null} onStop={(event) => {
        if (event.nativeEvent.isTrusted) void act(invite, "stop");
      }} onRecover={(action, event) => {
        if (event.nativeEvent.isTrusted) void act(invite, action);
      }} />;
    })}
  </section>;
}
