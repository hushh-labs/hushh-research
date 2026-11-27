"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { locationReviewDecision } from "@/lib/agent/main-chat-location-conversation";
import { Button } from "@/components/ui/button";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
import { subscribeToOneLocationStateChanges } from "@/lib/one-location/one-location-state-events";
import { publicInviteUrlLabel } from "@/lib/one-location/public-invite-url";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationPublicInvite, OneLocationState } from "@/lib/one-location/types";
import { LocationChatActionCard } from "./location-chat-action-card";
import { useLocationConversationTurn, type LocationConversationProps } from "./use-location-conversation-turn";

type Props = {
  token: string;
  ownerId: string;
  loadState: () => Promise<OneLocationState>;
  onChanged: () => void;
  onBack: () => void;
  onCreate: () => void;
} & LocationConversationProps;

function isActive(invite: OneLocationPublicInvite, now: number) {
  return invite.status === "active" && Boolean(invite.expiresAt && Date.parse(invite.expiresAt) > now);
}

export function LocationChatPublicLinks({ token, ownerId, loadState, onChanged, onBack, onCreate, onConversationReply, onConversationText }: Props) {
  const now = useCoarseClock(15_000);
  const [links, setLinks] = useState<OneLocationPublicInvite[] | null>(null);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<OneLocationPublicInvite | null>(null);
  const conversational = Boolean(onConversationText);
  const liveReply = useRef(false);
  useLayoutEffect(() => {
    liveReply.current = Boolean(onConversationReply);
    return () => { liveReply.current = false; };
  }, [onConversationReply]);
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
      const owned = (state.publicInvites ?? []).filter((entry) => entry.ownerUserId === ownerId);
      setLinks(owned);
      const active = owned.filter(invite => isActive(invite, Date.now()));
      if (conversational && active.length === 1) setReviewed(previous => previous ?? active[0]!);
      setError(undefined);
    } catch {
      if (currentIdentity.current === identity && refreshVersion.current === request) {
        setError("Couldn’t load your public links. Try again.");
      }
    }
  }, [conversational, identity, loadState, ownerId]);

  useEffect(() => {
    setLinks(null);
    setReviewed(null);
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
    const current = () => currentIdentity.current === identity && generation.current === started &&
      (!conversational || liveReply.current);
    try {
      if (action === "stop") {
        const state = await OneLocationService.getState(token);
        if (!current()) return;
        const fresh = state.publicInvites?.find((entry) => entry.id === invite.id && entry.ownerUserId === ownerId);
        if (conversational && (!fresh || !isActive(fresh, Date.now()) || fresh.expiresAt !== invite.expiresAt ||
            state.publicInvites?.filter(entry => entry.ownerUserId === ownerId && isActive(entry, Date.now())).length !== 1)) {
          setFeedback("Your public link changed. Ask me to review your current links.");
          await refresh();
          return;
        }
        if (fresh && isActive(fresh, Date.now())) {
          const revoked = await OneLocationService.revokePublicInvite({ vaultOwnerToken: token, inviteId: fresh.id });
          if (!current()) return;
          if (conversational && (revoked?.id !== fresh.id || revoked.ownerUserId !== ownerId || revoked.status !== "revoked")) {
            setError("I couldn’t verify that access through the public link stopped.");
            return;
          }
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
  const active = owned.filter(invite => isActive(invite, now));
  const target = reviewed && active.length === 1 && active[0]?.id === reviewed.id &&
    active[0].expiresAt === reviewed.expiresAt ? reviewed : null;
  const question = feedback || (error ? `${error} Type “retry” to check your links.`
    : busyId ? "Checking your public location link…"
    : !links ? "Checking your public links…"
    : !active.length ? "You have no active public location links."
    : active.length > 1 ? `You have ${active.length} active public links. I can’t identify a single link to stop.`
    : !target ? "Your public link changed. Ask me to review your current links."
    : `Your public location link expires ${new Date(target.expiresAt!).toLocaleString()}. Stop access for everyone with this link? Reply yes to stop it or no to keep it.`);
  useLocationConversationTurn({ onConversationReply, onConversationText }, conversational ? question : null, (reply) => {
    if (!liveReply.current || currentIdentity.current !== identity || operation.current || feedback) return false;
    const answer = reply.trim().toLowerCase().replace(/[.!]+$/, "");
    if (error && answer === "retry") { void refresh(); return true; }
    if (error || !target) return false;
    if (locationReviewDecision(reply) === "cancel") { setFeedback("Kept your public link active."); return true; }
    if (!["yes", "yes please", "confirm", "yes, stop it", "yes stop it"].includes(answer)) return false;
    void act(target, "stop");
    return true;
  });
  if (conversational) return null;
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
