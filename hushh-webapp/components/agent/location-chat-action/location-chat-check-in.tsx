"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { MainLocationProposal, MainLocationTarget } from "@/lib/agent/main-chat-location";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { resolveCircleRecipientSelection, sourceCircleIdForRecipient } from "@/lib/one-location/circle-recipient-selection";
import { executePrivateCheckIn } from "@/lib/one-location/command-private-check-in";
import { ONE_LOCATION_SHARE_NOTE_MAX_LENGTH } from "@/lib/one-location/message-limits";
import { isOneLocationNearbyCheckInAvailable } from "@/lib/one-location/nearby-check-in-availability";
import { OneLocationService } from "@/lib/one-location/service";
import { isShareReadyRecipient } from "@/lib/one-location/share-recipient-selection";
import type { OneLocationEncryptedEnvelope, OneLocationRecipient, PlainLocationPoint } from "@/lib/one-location/types";
import { LocationChatActionCard } from "./location-chat-action-card";
import { LocationChatSharePicker } from "./location-chat-share-picker";
import { captureChatLocation, chatLocationPermissionIssue, LocationChatPermissionRecovery, type ChatLocationPermissionIssue } from "./location-chat-permission";

type Audience = { person: OneLocationRecipient; circleId?: string };
type Review = {
  operationId: string; point: PlainLocationPoint; audience: Audience[];
  hours: number; note: string; confirmedAt?: string;
};

async function loadAudience(token: string, ownerId: string, choices: MainLocationTarget[]): Promise<Audience[]> {
  const ids = new Set(choices.flatMap((choice) => choice.personUserId ? [choice.personUserId] : []));
  const circles = choices.flatMap((choice) => choice.circleId ? [choice.circleId] : []);
  const [connections, selections] = await Promise.all([
    ids.size ? OneLocationService.listRecipients(token) : Promise.resolve([]),
    Promise.all(circles.map(async (circleId) => resolveCircleRecipientSelection({
      circle: await OneLocationService.getCircle({ vaultOwnerToken: token, circleId }),
      currentUserId: ownerId,
    }))),
  ]);
  const direct = connections.filter((person) => ids.has(person.userId) && person.userId !== ownerId && isShareReadyRecipient(person));
  if (direct.length !== ids.size) throw new Error("A selected contact can no longer receive a private check-in.");
  const audience = new Map(direct.map((person) => [person.userId, { person }] as [string, Audience]));
  for (const selection of selections) {
    for (const { recipient } of selection.ready) {
      if (audience.has(recipient.userId)) continue;
      const circleId = sourceCircleIdForRecipient(selections, recipient.userId);
      if (circleId) audience.set(recipient.userId, { person: recipient, circleId });
    }
  }
  if (!audience.size) throw new Error("No one selected can receive a private check-in.");
  return [...audience.values()];
}

export function LocationChatCheckIn({ proposal, ownerId, token, capturePoint, onBack, onChanged, renderPoint }: {
  proposal: MainLocationProposal;
  ownerId: string;
  token: string;
  vaultKey?: string | null;
  capturePoint: () => Promise<PlainLocationPoint>;
  onBack: () => void;
  onChanged: () => void;
  renderPoint: (point: PlainLocationPoint) => ReactNode;
}) {
  if (proposal.action === "nearby_check_in") return <NearbyReview />;
  return <PrivateCheckIn proposal={proposal} ownerId={ownerId} token={token}
    capturePoint={capturePoint} onBack={onBack} onChanged={onChanged} renderPoint={renderPoint} />;
}

function NearbyReview() {
  if (!isOneLocationNearbyCheckInAvailable()) return <LocationChatActionCard model={{
    phase: "result", title: "Nearby check-in", status: "Nearby check-in is unavailable in this app.",
  }} />;
  return <LocationChatActionCard model={{
    phase: "result", title: "Nearby check-in",
    description: "Choose a nearby place or manage your active check-in.",
  }} map={<Button asChild size="sm"><Link href={ROUTES.ONE_LOCATION_CHECK_IN} prefetch={false}>Open check-in</Link></Button>} />;
}

function PrivateCheckIn({ proposal, ownerId, token, capturePoint, onBack, onChanged, renderPoint }: Omit<Parameters<typeof LocationChatCheckIn>[0], "vaultKey">) {
  const [choices, setChoices] = useState<MainLocationTarget[]>([]);
  const [review, setReview] = useState<Review>();
  const [draftMinutes, setDraftMinutes] = useState(proposal.durationHours ? Math.round(proposal.durationHours * 60) : 60);
  const [note, setNote] = useState("");
  const [succeeded, setSucceeded] = useState<Audience[]>([]);
  const [error, setError] = useState<string>();
  const [permissionIssue, setPermissionIssue] = useState<ChatLocationPermissionIssue>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const activeSession = useRef(0);
  const envelopeCache = useRef(new Map<string, OneLocationEncryptedEnvelope>());
  const noteId = useId();
  useLayoutEffect(() => () => {
    activeSession.current += 1;
    envelopeCache.current.clear();
  }, [ownerId, token]);
  useEffect(() => () => { busyRef.current = false; }, []);

  function clearReview() {
    envelopeCache.current.clear();
    setReview(undefined);
    setError(undefined);
    setPermissionIssue(null);
  }

  useBackLayer(ROUTES.HOME, choices.length ? 2 : 0, () => {
    if (busyRef.current) return true;
    if (review && !succeeded.length) clearReview();
    else if (!succeeded.length) setChoices([]);
    else onBack();
    return true;
  });

  async function run(task: (isCurrent: () => boolean) => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setPermissionIssue(null);
    const version = activeSession.current;
    const isCurrent = () => version === activeSession.current;
    try { await task(isCurrent); }
    catch (caught) {
      if (!isCurrent()) return;
      const issue = chatLocationPermissionIssue(caught);
      setPermissionIssue(issue);
      setError(issue === "denied" ? "Location permission was denied." :
        caught instanceof Error ? caught.message : "Couldn’t complete this check-in.");
    } finally {
      busyRef.current = false;
      if (isCurrent()) setBusy(false);
    }
  }

  const noteField = <div className="space-y-1">
    <label className="text-sm font-medium" htmlFor={noteId}>Optional check-in message</label>
    <Textarea id={noteId} value={note} maxLength={ONE_LOCATION_SHARE_NOTE_MAX_LENGTH}
      onChange={(event) => setNote(event.target.value)} disabled={busy} />
  </div>;

  return <>
    <div hidden={Boolean(choices.length)}>
      <LocationChatSharePicker checkIn token={token} ownerId={ownerId} busy={busy}
        suggestedPeople={proposal.people} suggestedCircles={proposal.circles}
        onBack={onBack} onContinue={(_, targets) => setChoices(targets)} />
    </div>
    {succeeded.length ? <LocationChatActionCard model={{
      phase: "result", title: "Check-in sent",
      facts: [{ label: "Recipients", value: succeeded.map(({ person }) => person.displayName).join(", ") }],
      error: !review ? error : undefined,
    }} /> : null}
    {choices.length && !review && !succeeded.length ? <LocationChatActionCard model={{
      phase: "review", title: "Private check-in", subject: { label: choices.map((choice) => choice.label).join(", ") },
      confirmLabel: "Preview check-in", dismissLabel: "Back", error,
      duration: { kind: "duration", options: [...new Set([30, 60, 120, draftMinutes])].sort((a, b) => a - b), minutes: draftMinutes },
    }} busy={busy} map={noteField} onDismiss={() => { setChoices([]); clearReview(); }} onConfirm={(input, event) => {
      if (!event.nativeEvent.isTrusted) return;
      const minutes = input.durationMinutes ?? draftMinutes;
      setDraftMinutes(minutes);
      void run(async (isCurrent) => {
        const [point, audience] = await Promise.all([capturePoint(), loadAudience(token, ownerId, choices)]);
        if (isCurrent()) setReview({ operationId: crypto.randomUUID(), point, audience, hours: minutes / 60, note: note.trim() });
      });
    }} /> : null}
    {review ? <LocationChatActionCard model={{
      phase: "review", title: "Review private check-in", confirmLabel: review.confirmedAt ? "Retry check-in" : "Send check-in",
      dismissLabel: review.confirmedAt ? "Close" : "Edit",
      facts: [
        { label: "Recipients", value: review.audience.map(({ person }) => person.displayName).join(", ") },
        { label: "Duration", value: `${Math.round(review.hours * 60)} minutes` },
        ...(review.note ? [{ label: "Message", value: review.note }] : []),
      ], error,
    }} busy={busy} map={renderPoint(review.point)} onDismiss={review.confirmedAt ? onBack : clearReview} onConfirm={(_, event) => {
      if (!event.nativeEvent.isTrusted) return;
      void run(async (isCurrent) => {
        const confirmedAt = review.confirmedAt ?? new Date().toISOString();
        if (!review.confirmedAt && Date.now() - Date.parse(review.point.capturedAt) > 55_000) {
          clearReview();
          throw new Error("The preview expired. Capture your current location again.");
        }
        const [, fresh] = await Promise.all([captureChatLocation(), loadAudience(token, ownerId, choices)]);
        if (!isCurrent()) return;
        const freshById = new Map(fresh.map((entry) => [entry.person.userId, entry]));
        if (review.audience.some(({ person, circleId }) => {
          const current = freshById.get(person.userId);
          return current?.person.keyId !== person.keyId || current?.circleId !== circleId;
        })) {
          clearReview();
          throw new Error("The recipients changed. Review the check-in again.");
        }
        const remaining: Audience[] = [];
        const sent: Audience[] = [];
        let reason: string | undefined;
        const circleIds = new Set(review.audience.map((entry) => entry.circleId));
        for (const circleId of circleIds) {
          if (!isCurrent()) break;
          const group = review.audience.filter((entry) => entry.circleId === circleId);
          try {
            const result = await executePrivateCheckIn({ ownerId, token, envelopeCache: envelopeCache.current, isCurrent,
              recipients: group.map(({ person }) => person),
              request: { recipientIds: group.map(({ person }) => person.userId), durationHours: String(review.hours),
                point: review.point, message: review.note, clientOperationId: review.operationId, confirmedAt, sourceCircleId: circleId },
            });
            sent.push(...group.filter(({ person }) => result.succeededRecipientIds.includes(person.userId)));
            remaining.push(...group.filter(({ person }) => result.failedRecipientIds.includes(person.userId)));
          } catch (caught) {
            remaining.push(...group);
            if (caught instanceof Error) reason ??= caught.message;
          }
        }
        if (sent.length) onChanged();
        if (!isCurrent()) return;
        setSucceeded((previous) => [...previous, ...sent]);
        if (remaining.length) {
          setReview({ ...review, audience: remaining, confirmedAt });
          const names = remaining.map(({ person }) => person.displayName).join(", ");
          setError(`The check-in could not be confirmed for ${names}.${reason ? ` ${reason}` : ""}`);
        } else {
          clearReview();
        }
      });
    }} /> : null}
    <LocationChatPermissionRecovery issue={permissionIssue} />
  </>;
}
