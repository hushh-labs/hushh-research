"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SmsContactsFlow } from "@/components/one-location/redesign/sms-contacts-flow";
import { SosPanel, type SosDispatchStatus } from "@/components/one-location/redesign/sos-panel";
import { Button } from "@/components/ui/button";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import type { LocationSafetyAction } from "@/lib/agent/main-chat-location-contract";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import {
  loadChatSosActiveReview, loadChatSosReview, sendChatSos, stopChatSos,
  type ChatSosDelivery, type ChatSosReview,
} from "@/lib/one-location/chat-sos";
import { resolveCircleRecipientSelection } from "@/lib/one-location/circle-recipient-selection";
import { readOneLocationControlState, updateOneLocationControlState } from "@/lib/one-location/location-control-state";
import { subscribeToOneLocationStateChanges } from "@/lib/one-location/one-location-state-events";
import { OneLocationService } from "@/lib/one-location/service";
import { isSosShareReadyRecipient } from "@/lib/one-location/sos-trigger";
import type { OneLocationCircleSummary, OneLocationRecipient } from "@/lib/one-location/types";
import { LocationChatActionCard } from "./location-chat-action-card";
import { captureChatLocation, chatLocationPermissionIssue, enableChatDeviceLocation, LocationChatPermissionRecovery, type ChatLocationPermissionIssue } from "./location-chat-permission";
import { locationReviewDecision } from "@/lib/agent/main-chat-location-conversation";
import { useLocationConversationTurn, type LocationConversationProps } from "./use-location-conversation-turn";

function personName(person: OneLocationRecipient) {
  return person.displayName.trim() || "Emergency contact";
}

function deliveryStatus(result: ChatSosDelivery | null): SosDispatchStatus | undefined {
  if (!result) return undefined;
  if (result.delivery.some((row) => row.alerted === true)) return "sent";
  if (result.emailed) return "email-only";
  return result.delivery.some((row) => row.alerted === null && !row.failed) ? "unconfirmed" : "failed";
}

function deliveryFacts(result: ChatSosDelivery) {
  const confirmed = result.delivery.filter((row) => row.alerted === true).map((row) => row.displayName);
  const failed = result.delivery.filter((row) => row.failed || row.alerted === false).map((row) => row.displayName);
  const unknown = result.delivery.filter((row) => !row.failed && row.alerted === null).map((row) => row.displayName);
  return [
    ...(confirmed.length ? [{ label: "In-app alerts confirmed", value: confirmed.join(", ") }] : []),
    ...(failed.length ? [{ label: "In-app alerts not confirmed", value: failed.join(", ") }] : []),
    ...(unknown.length ? [{ label: "In-app delivery unknown", value: unknown.join(", ") }] : []),
    ...(result.emailed ? [{ label: "Email alerts sent", value: String(result.emailed) }] : []),
    ...(result.withoutEmail.length ? [{ label: "Email unavailable", value: result.withoutEmail.join(", ") }] : []),
    ...(result.skippedNotReady.length ? [{ label: "Contacts not ready", value: result.skippedNotReady.map(personName).join(", ") }] : []),
    ...(result.unavailableContactCount ? [{ label: "Unavailable contacts", value: String(result.unavailableContactCount) }] : []),
  ];
}

export function LocationChatSafety({ action, ownerId, token, allowReview, onConversationReply, onConversationText }: {
  action: LocationSafetyAction;
  ownerId: string;
  token: string;
  allowReview: boolean;
} & LocationConversationProps) {
  const [editing, setEditing] = useState(action === "sms_contacts");
  const [closed, setClosed] = useState(false);
  const [review, setReview] = useState<ChatSosReview | null>(null);
  const [directory, setDirectory] = useState<{ recipients: OneLocationRecipient[]; circles: OneLocationCircleSummary[] }>();
  const [delivery, setDelivery] = useState<ChatSosDelivery | null>(null);
  const [checkingEmail, setCheckingEmail] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [contactEdit, setContactEdit] = useState<{ id: string; name: string; remove: boolean; members?: string[] }>();
  const [contactPrompt, setContactPrompt] = useState<string>();
  const [permissionIssue, setPermissionIssue] = useState<ChatLocationPermissionIssue>(null);
  const [deviceReady, setDeviceReady] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const busy = useRef<symbol | null>(null);
  const sendRevision = useRef(0);
  const readRevision = useRef(0);
  const session = useRef<{ ownerId: string; token: string; allowReview: boolean; closed: boolean } | null>(null);
  useLayoutEffect(() => {
    session.current = { ownerId, token, allowReview, closed };
    return () => { session.current = null; };
  }, [ownerId, token, allowReview, closed]);
  const sameSession = useCallback(() => session.current?.ownerId === ownerId && session.current.token === token, [ownerId, token]);
  const isCurrent = useCallback(() => sameSession() && Boolean(session.current?.allowReview && !session.current.closed), [sameSession]);

  const loadReview = useCallback(() => {
    if (!isCurrent() || busy.current) return;
    const read = ++readRevision.current;
    const current = () => isCurrent() && read === readRevision.current;
    const load = action === "sos_stop" ? loadChatSosActiveReview : loadChatSosReview;
    void load({ ownerId, token, isCurrent: current }).then((next) => {
      if (current()) setReview(next);
    }).catch((caught) => {
      if (current()) setError(message(caught));
    });
  }, [action, isCurrent, ownerId, token]);

  useEffect(() => {
    if (!allowReview || closed) return;
    loadReview();
    const unsubscribe = subscribeToOneLocationStateChanges((event) => {
      if (event.userId === ownerId) loadReview();
    });
    window.addEventListener("focus", loadReview);
    const cancelPendingReads = () => { ++readRevision.current; };
    return () => {
      cancelPendingReads();
      unsubscribe();
      window.removeEventListener("focus", loadReview);
    };
  }, [allowReview, closed, loadReview, ownerId, refreshKey]);

  useEffect(() => {
    if (!editing || !allowReview || closed || directory) return;
    let current = true;
    void Promise.all([OneLocationService.listRecipients(token), OneLocationService.listCircles(token)]).then(([recipients, circles]) => {
      if (current && isCurrent()) setDirectory({ recipients: recipients.filter((person) => person.userId !== ownerId), circles });
    }).catch((caught) => { if (current && isCurrent()) setError(message(caught)); });
    return () => { current = false; };
  }, [allowReview, closed, directory, editing, isCurrent, ownerId, refreshKey, token]);

  function close() {
    if (busy.current) return;
    if (editing && action !== "sms_contacts") {
      setEditing(false);
      setError(undefined);
      loadReview();
    } else {
      setClosed(true);
    }
  }
  useBackLayer(ROUTES.HOME, allowReview && !closed ? 1 : 0, () => { close(); return true; });

  function retry() {
    setError(undefined);
    setRefreshKey((value) => value + 1);
  }

  async function run<T>(key: string, perform: (release: () => void) => Promise<T>): Promise<T | undefined> {
    if (!isCurrent() || busy.current) return undefined;
    const operation = Symbol(key);
    busy.current = operation;
    ++readRevision.current;
    setBusyKey(key);
    setError(undefined);
    setStatus(undefined);
    const release = () => {
      if (busy.current !== operation) return;
      busy.current = null;
      if (sameSession()) setBusyKey(null);
    };
    try {
      return await perform(release);
    } catch (caught) {
      if (isCurrent() && busy.current === operation) {
        setError(message(caught));
        const issue = chatLocationPermissionIssue(caught);
        setPermissionIssue(issue);
        if (issue) setDeviceReady(false);
      }
      return undefined;
    } finally {
      release();
    }
  }

  const loadMembers = useCallback(async (circleId: string) => {
    const circle = await OneLocationService.getCircle({ vaultOwnerToken: token, circleId });
    if (!isCurrent() || circle.systemKind === "trusted") throw new Error("This Circle is unavailable.");
    return resolveCircleRecipientSelection({ circle, currentUserId: ownerId });
  }, [isCurrent, ownerId, token]);

  async function refreshRoster() {
    if (!isCurrent()) return;
    const updated = await loadChatSosReview({ ownerId, token, isCurrent });
    if (isCurrent()) setReview(updated);
  }

  async function changeContact(userId: string, removing: boolean) {
    return await run(`sms-contact:${userId}`, async () => {
      const contacts = await (removing ? OneLocationService.removeSmsContact : OneLocationService.addSmsContact)({
        vaultOwnerToken: token, recipientUserId: userId,
      });
      if (contacts.includes(userId) === removing) throw new Error("Your emergency contacts could not be updated.");
      CacheSyncService.onOneLocationStateMutated(ownerId, ["workspace"]);
      if (!isCurrent()) return false;
      setReview((current) => current ? { ...current, contactUserIds: contacts } : current);
      setStatus(removing ? "Emergency contact removed." : "Emergency contact added.");
      try { await refreshRoster(); } catch { setError("Emergency contacts were saved. Refresh to check the current list."); }
      return true;
    }) ?? false;
  }

  async function addCircleMembers(circleId: string, userIds: string[], requireSameMembers = false) {
    await run(`sms-circle:${circleId}`, async () => {
      const selection = await loadMembers(circleId);
      if (!isCurrent()) return;
      if (requireSameMembers) {
        const currentIds = selection.ready.filter(({ recipient }) => !review?.contactUserIds.includes(recipient.userId))
          .map(({ recipient }) => recipient.userId);
        if (currentIds.length !== userIds.length || currentIds.some(id => !userIds.includes(id))) {
          throw new Error("The Circle membership changed. Ask again to review the current members.");
        }
      }
      const targets = selection.ready.filter(({ recipient }) => userIds.includes(recipient.userId) &&
        !review?.contactUserIds.includes(recipient.userId));
      const results = await Promise.allSettled(targets.map(({ recipient }) => OneLocationService.addSmsContact({
        vaultOwnerToken: token, recipientUserId: recipient.userId,
      })));
      const added = targets.filter(({ recipient }, index) => {
        const result = results[index];
        return result?.status === "fulfilled" && result.value.includes(recipient.userId);
      }).length;
      if (added) CacheSyncService.onOneLocationStateMutated(ownerId, ["workspace"]);
      if (!isCurrent()) return;
      setStatus(`Added ${added} of ${targets.length} emergency contacts.`);
      await refreshRoster();
    });
  }

  async function send(note?: string | null, fromConversation = false) {
    if (!review || editing || busy.current || !(deviceReady || fromConversation) || readOneLocationControlState(ownerId).paused) return;
    const revision = ++sendRevision.current;
    const current = () => isCurrent() && revision === sendRevision.current;
    const result = await run("send", (release) => sendChatSos({ ownerId, token, review, note, isCurrent: current,
      onPublished: (published) => {
        if (!current()) return;
        setReview({ ...review, incident: published.incident });
        setDelivery({ ...published, emailed: 0, withoutEmail: [] });
        setCheckingEmail(true);
        release();
      },
    }));
    if (!current()) return;
    setCheckingEmail(false);
    if (result) {
      setReview({ ...review, incident: result.incident });
      setDelivery(result);
    } else {
      loadReview();
    }
  }

  async function stop() {
    if (!review || busy.current) return;
    ++sendRevision.current;
    setCheckingEmail(false);
    const result = await run("stop", () => stopChatSos({ ownerId, token, review, isCurrent }));
    if (!isCurrent()) return;
    if (result) {
      const stillActive = new Set(result.unresolved);
      setReview({
        ...review,
        activeGrants: review.activeGrants.filter((grant) => stillActive.has(grant.id)),
        incident: review.incident && result.unresolved.length ? { ...review.incident, grantIds: result.unresolved } : null,
      });
      if (result.unresolved.length) setError(`Couldn’t stop sharing with ${result.unresolved.length} emergency contact(s). Try stopping the alert again.`);
      else {
        setStatus("Save My Soul alert stopped.");
        setDelivery(null);
        setClosed(true);
      }
    } else {
      loadReview();
    }
  }

  const active = Boolean(review?.activeGrants.length || review?.incident?.grantIds.length);
  const paused = readOneLocationControlState(ownerId).paused;
  const ready = review?.recipients.filter(isSosShareReadyRecipient) ?? [];
  const recipients = ready.map(personName).join(", ");
  const skipped = review ? review.contactUserIds.length - ready.length : 0;
  const contacts = [...new Map([...(directory?.recipients ?? []), ...(review?.recipients ?? [])]
    .map((person) => [person.userId, person])).values()];
  const rosterNames = contacts.filter(person => review?.contactUserIds.includes(person.userId)).map(personName);
  const contactText = !directory || !review ? "Checking your emergency contacts…" : contactEdit
    ? `${contactEdit.remove ? "Remove" : "Add"} ${contactEdit.name} ${contactEdit.remove ? "from" : "to"} your emergency contacts? Reply yes to confirm or no to cancel.`
    : contactPrompt || `${rosterNames.length ? `Your emergency contacts are ${rosterNames.join(", ")}.` : "You have no named emergency contacts."} Reply “add” or “remove” followed by a name.`;
  function reviewContactReply(reply: string): boolean {
    if (!directory || !review) return false;
    const decision = locationReviewDecision(reply);
    if (decision === "cancel") { setClosed(true); return true; }
    if (contactEdit && decision === "confirm") {
      const edit = contactEdit;
      setContactEdit(undefined);
      if (edit.members) void addCircleMembers(edit.id, edit.members, true);
      else void changeContact(edit.id, edit.remove);
      return true;
    }
    const match = /^(add|remove)\s+(.+?)(?:\s+(?:to|from) my emergency contacts)?[.!]?$/i.exec(reply.trim());
    if (!match) return false;
    setContactEdit(undefined);
    const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase();
    const name = normalize(match[2]!);
    const remove = normalize(match[1]!) === "remove";
    const people = contacts.filter(person => [personName(person), `${personName(person)} ${person.maskedPhone || ""}`]
      .some(label => normalize(label) === name));
    const circles = remove ? [] : directory.circles.filter(circle => circle.systemKind !== "trusted" &&
      [circle.name, `${circle.name} circle`].some(label => normalize(label) === name));
    if (people.length + circles.length !== 1) {
      const labels = people.map(person => [personName(person), person.maskedPhone].filter(Boolean).join(" "));
      setContactPrompt(labels.length > 1 ? `Which contact? Reply with add or remove and the full label: ${labels.join(", ")}.`
        : "Please give the exact connection name or Circle name so I can identify the right emergency contact.");
      return true;
    }
    const person = people[0];
    if (person) {
      if (review.contactUserIds.includes(person.userId) !== remove || (!remove && !isSosShareReadyRecipient(person))) {
        setContactPrompt(`${personName(person)} ${remove ? "is not an emergency contact" : review.contactUserIds.includes(person.userId) ? "is already an emergency contact" : "is not ready to receive a live Location alert"}.`);
      } else {
        setContactEdit({ id: person.userId, name: personName(person), remove });
      }
    } else if (circles[0]) {
      const circle = circles[0];
      void run("review-circle", async () => {
        const selection = await loadMembers(circle.id);
        if (!isCurrent()) return;
        const members = selection.ready.map(row => row.recipient).filter(member => !review.contactUserIds.includes(member.userId));
        if (!members.length) { setContactPrompt("This Circle has no eligible new emergency contacts."); return; }
        setContactEdit({ id: circle.id, name: members.map(personName).join(", "), remove: false, members: members.map(member => member.userId) });
      });
    }
    return true;
  }
  const text = status || error || (action === "sms_contacts" ? closed ? "Cancelled." : busyKey ? "Updating emergency contacts…" : contactText : delivery ? [
    ...deliveryFacts(delivery).map(({ label, value }) => `${label}: ${value}.`),
    checkingEmail ? "Checking email delivery…" : delivery.emailError, delivery.error,
  ].filter(Boolean).join(" ") : closed ? "Cancelled." : !review ? "Checking your Save My Soul alert…"
    : busyKey ? "Working on your Save My Soul request…"
      : action === "sos_stop" ? active ? "Stop your active Save My Soul alert and its location shares? Reply yes to stop it." : "You have no active Save My Soul alert."
        : active ? "Your Save My Soul alert is already active."
          : !ready.length ? "You have no emergency contacts ready to receive a Save My Soul alert."
            : paused ? "Location updates are paused. Resume them on this device? Your existing shares can start updating again. Reply yes to resume."
              : `Send a Save My Soul alert and share your live location with ${recipients}?${skipped ? ` ${skipped} emergency contact(s) can’t receive this alert.` : ""} Reply yes to send.`);
  useLocationConversationTurn({ onConversationReply, onConversationText }, allowReview ? text : null, (reply) => {
    if (!isCurrent() || !review || busy.current || closed || status || delivery || error) return false;
    if (action === "sms_contacts") return reviewContactReply(reply);
    if (action === "sos_stop" ? !active : active || !ready.length) return false;
    const decision = locationReviewDecision(reply);
    if (decision === "cancel") { close(); return true; }
    if (decision !== "confirm") return false;
    if (action === "sos_stop") void stop();
    else if (paused) {
      void run("device", async () => {
        await enableChatDeviceLocation(isCurrent);
        if (!isCurrent()) return;
        updateOneLocationControlState(ownerId, (control) => ({ ...control, paused: false }));
        setDeviceReady(true);
      });
    } else {
      void send(null, true);
    }
    return true;
  });
  if (onConversationText) return <LocationChatPermissionRecovery issue={permissionIssue} />;
  if (!allowReview || closed) return status || delivery ? <LocationChatActionCard model={{
    phase: "result", title: "Save My Soul", status, facts: delivery ? deliveryFacts(delivery) : undefined,
  }} /> : null;
  if (!review && !editing) return <LocationChatActionCard model={{
    phase: "recovery", title: "Save My Soul", description: error ?? "Checking for a Save My Soul alert…",
    actions: error ? [{ id: "retry", label: "Try again", variant: "primary" }, { id: "cancel", label: "Cancel" }] : [],
  }} onRecover={(id) => { if (id === "retry") retry(); else close(); }} />;
  if (action === "sos_stop" && !active) return <LocationChatActionCard model={{
    phase: "result", title: "Save My Soul", status: "No active alert.",
  }} />;
  return <div className="space-y-3 rounded-2xl border border-border bg-card p-3 sm:p-4">
    {action !== "sms_contacts" && review ? <div hidden={editing} className="space-y-3">
      {!active && ready.length ? <>
        <LocationChatActionCard model={{
          phase: "result", title: "Alert recipients",
          facts: [
            { label: "Live location and optional message", value: ready.map(personName).join(", ") },
            ...(review.contactUserIds.length > ready.length ? [{
              label: "Contacts unable to receive this alert", value: String(review.contactUserIds.length - ready.length),
            }] : []),
          ],
        }} />
        {(!deviceReady || paused) ? <LocationChatActionCard model={{
          phase: "recovery", title: paused ? "Location updates are paused" : "Device location",
          description: paused ? "Resuming updates can restart other active location shares on this device." : "Check your device location before sending the alert.",
          actions: [{ id: "device", label: paused ? "Resume updates" : "Check device location", variant: "primary" }],
        }} busy={busyKey !== null} onRecover={(_, event) => {
          if (!event.nativeEvent.isTrusted) return;
          setPermissionIssue(null);
          void run("device", async () => {
            await captureChatLocation();
            if (!isCurrent()) return;
            if (paused) updateOneLocationControlState(ownerId, (current) => ({ ...current, paused: false }));
            setDeviceReady(true);
          });
        }} /> : null}
      </> : null}
      {!active && review.contactUserIds.length > 0 && !ready.length ? <p role="status" className="text-sm">No emergency contacts are ready to receive this alert.</p> : null}
      <LocationChatPermissionRecovery issue={permissionIssue} />
      <SosPanel
        recipients={ready} contactCount={review.contactUserIds.length}
        active={active} dispatchStatus={checkingEmail && deliveryStatus(delivery) !== "sent" ? "sending" : deliveryStatus(delivery)}
        busy={busyKey === "send"} sendBlocked={editing || busyKey !== null || !ready.length || !deviceReady || paused}
        requireTrustedInput stopBusy={busyKey === "stop"}
        onTrigger={send} onStopSos={() => { void stop(); }} onClose={close}
        onEditContacts={() => { if (!busy.current) setEditing(true); }}
        recipientLabel={personName} isRecipientShareReady={isSosShareReadyRecipient}
        emergency={null} emergencyStatus="idle" onResolveEmergencyNumber={() => undefined}
      />
      {delivery ? <LocationChatActionCard model={{
        phase: "result", title: "Alert delivery", facts: deliveryFacts(delivery),
        status: checkingEmail ? "Checking email delivery…" : undefined,
        error: [delivery.error, delivery.emailError].filter(Boolean).join(" ") || undefined,
      }} /> : null}
    </div> : null}
    {editing && directory && review ? <SmsContactsFlow
      embeddedInChat
      recipients={contacts} circles={directory.circles} selectedUserIds={review.contactUserIds} busyKey={busyKey}
      onAdd={(userId) => { void changeContact(userId, false); }}
      onAddCircleMembers={addCircleMembers} onLoadCircleMembers={loadMembers}
      onRemove={(userId) => changeContact(userId, true)}
      recipientLabel={personName}
      recipientSubtitle={(person) => person.maskedPhone || (isSosShareReadyRecipient(person) ? "Ready for Save My Soul" : "Location receiving unavailable")}
      isRecipientShareReady={isSosShareReadyRecipient}
    /> : null}
    {editing && (!directory || !review) && !error ? <p role="status">Loading emergency contacts…</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {status ? <p role="status" className="text-sm text-muted-foreground">{status}</p> : null}
    <div className="flex flex-wrap justify-end gap-2">
      {error && editing ? <Button type="button" variant="outline" onClick={retry}>Refresh contacts</Button> : null}
      <Button type="button" variant="outline" onClick={close} disabled={busyKey !== null}>{editing ? "Done" : "Close"}</Button>
    </div>
  </div>;
}

function message(error: unknown) {
  if (!navigator.onLine) return "You’re offline. Reconnect and try again.";
  if (chatLocationPermissionIssue(error) === "denied") return "Location permission was denied.";
  return error instanceof Error ? error.message : "Couldn’t complete this Location action. Try again.";
}
