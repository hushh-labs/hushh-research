"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import calendarPresentation from "./calendar-presentation.module.css";
import { connectCalendarInPlace, connectGmailInPlace, type InPlaceConnectOwner, type ConnectControls } from "@/lib/connections/google-connect-in-place";
import { snapshotValidatedAuthSessionPrincipal, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { GoogleCalendarService, type CalendarAttendanceResult } from "@/lib/services/google-calendar-service";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { calendarAccountStatus, calendarDirectiveAccountId } from "@/lib/calendar/calendar-account-status";
import { CalendarInvitations } from "./calendar-invitations";
import { useCalendarHusshPeople } from "@/lib/calendar/use-calendar-hussh-people";
import type { InvitationDecision, InvitationTerms } from "./calendar-invitation-actions";

/** The shared Calendar controls stay in this chat; OAuth opens in place. */
export function CalendarInvitationChat({ owner, ownerId: applicationOwnerId, payload, expectedAccountEmail, expectedAccountId, onResult, onClose, onBusyChange, vaultOwnerCapability, confirmLegacyTransition }: { vaultOwnerCapability?: string | null; confirmLegacyTransition?: ConnectControls["confirmLegacyTransition"]; owner: InPlaceConnectOwner; ownerId: string; payload: Record<string, unknown>; expectedAccountEmail?: string; expectedAccountId?: string; onResult: (result: CalendarAttendanceResult) => void; onClose: () => void; onBusyChange?: (busy: boolean) => void }) {
  const selectedAccountId = calendarDirectiveAccountId(payload);
  const accountId = selectedAccountId ?? "";
  const [revision, setRevision] = useState(0);
  const [connectAttempt, setConnectAttempt] = useState<{ ownerId: string; accountId: string; capability: string | null | undefined } | null>(null);
  const busy = connectAttempt?.ownerId === applicationOwnerId && connectAttempt.accountId === accountId && connectAttempt.capability === vaultOwnerCapability;
  const [actionBusy, setActionBusy] = useState(false);
  const [accountObservation, setAccountObservation] = useState<{ ownerId: string; accountId: string; connected: boolean; email: string | null } | null>(null);
  const account = accountObservation?.ownerId === applicationOwnerId && accountObservation.accountId === accountId ? accountObservation.email : null;
  const calendarPeople = useCalendarHusshPeople({
    userId: applicationOwnerId,
    accountKey: accountId,
    connectionRevision: revision,
    getIdToken: () => owner.getIdToken(),
    vaultOwnerToken: vaultOwnerCapability ?? null,
  });
  const lifetime = useRef<AbortController | null>(null);
  const binding = useRef({ ownerId: applicationOwnerId, accountId, capability: vaultOwnerCapability });
  binding.current = { ownerId: applicationOwnerId, accountId, capability: vaultOwnerCapability };
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => { controller.abort(); }; }, [applicationOwnerId, accountId, vaultOwnerCapability]);
  useEffect(() => {
    let active = true;
    const principal = snapshotValidatedAuthSessionPrincipal();
    const current = () => Boolean(active && principal && principal.firebaseUid === owner.uid
      && principal.ownerId === applicationOwnerId && isValidatedAuthSessionOwnerCurrent(principal));
    if (!current() || selectedAccountId === null) return;
    void owner.getIdToken().then(idToken => {
      if (!current()) throw new Error("OWNER_CHANGED");
      return GoogleCalendarService.status(idToken, applicationOwnerId);
    }).then(status => {
      const selected = calendarAccountStatus(status, accountId);
      if (current()) setAccountObservation({ ownerId: applicationOwnerId, accountId,
        connected: selected?.connected === true, email: selected?.google_email || null });
    }).catch(() => { if (current()) setAccountObservation({ ownerId: applicationOwnerId, accountId, connected: false, email: null }); });
    return () => { active = false; };
  }, [owner, applicationOwnerId, accountId, selectedAccountId, revision]);
  const connect = (kind: "calendar" | "mail", access: "read" | "manage" = "manage", includeCalendarList = false) => {
    const controller = lifetime.current;
    const principal = snapshotValidatedAuthSessionPrincipal();
    if (busy || !controller || !principal || principal.firebaseUid !== owner.uid || principal.ownerId !== applicationOwnerId) return;
    const ownerId = applicationOwnerId, capability = vaultOwnerCapability, epoch = snapshotVaultSessionEpoch();
    const controls = { owner, signal: controller.signal, vaultOwnerCapability: capability, confirmLegacyTransition,
      isCurrent: () => isValidatedAuthSessionOwnerCurrent(principal) && lifetime.current === controller && !controller.signal.aborted &&
        binding.current.ownerId === ownerId && binding.current.accountId === accountId && binding.current.capability === capability && isVaultSessionEpochCurrent(epoch) };
    const attempt = kind === "calendar" ? connectCalendarInPlace({ ...controls, accountId, accessLevel: access, includeCalendarList }) : connectGmailInPlace({ ...controls, purpose: "send" });
    setConnectAttempt({ ownerId, accountId, capability });
    void attempt.result.then(result => { if (controls.isCurrent()) { if (result === "connected") setRevision(value => value + 1); else if (result !== "stale") morphyToast.error("Access was not updated. You can try again."); } }).finally(() => { if (controls.isCurrent()) setConnectAttempt(null); });
  };
  if (selectedAccountId === null) return <div role="alert"><p>The Calendar account selection is invalid. Close this review and check the invitation again.</p><Button variant="ghost" size="compact" onClick={onClose}>Close invitations</Button></div>;
  if (accountObservation?.ownerId !== applicationOwnerId || accountObservation.accountId !== accountId) return <div><p role="status">Checking Calendar connection…</p><Button variant="ghost" size="compact" className={calendarPresentation.utility} onClick={onClose}>Close invitations</Button></div>;
  if (expectedAccountId !== undefined && expectedAccountId !== accountId) return <div role="alert"><p>The Calendar account selection changed. Close this review and check the invitation again.</p><Button variant="ghost" size="compact" onClick={onClose}>Close invitations</Button></div>;
  if (!accountObservation.connected) return <div role="alert"><p>The selected Calendar account is unavailable. Reconnect it before checking this invitation.</p><Button disabled={busy} onClick={() => connect("calendar")}>Reconnect Calendar</Button><Button variant="ghost" size="compact" onClick={onClose}>Close invitations</Button></div>;
  const boundAccount = expectedAccountEmail || (typeof payload.accountEmail === "string" ? payload.accountEmail : account);
  if (boundAccount && account && boundAccount.toLowerCase() !== account.toLowerCase()) return <div role="alert"><p>The connected Calendar account changed. Close this review and ask One to check the invitation again.</p><Button variant="ghost" size="compact" className={calendarPresentation.utility} onClick={onClose}>Close invitations</Button></div>;
  const rawTerms = payload.terms && typeof payload.terms === "object" ? payload.terms as Record<string, unknown> : {};
  const terms: InvitationTerms = {
    date: typeof rawTerms.date === "string" ? rawTerms.date : undefined,
    startTime: typeof rawTerms.startTime === "string" ? rawTerms.startTime : undefined,
    endTime: typeof rawTerms.endTime === "string" ? rawTerms.endTime : undefined,
    durationMinutes: typeof rawTerms.durationMinutes === "number" ? rawTerms.durationMinutes : undefined,
    message: typeof rawTerms.message === "string" ? rawTerms.message : undefined,
  };
  const decision: InvitationDecision = payload.decision === "accepted" || payload.decision === "declined" || payload.decision === "offer_times" ? payload.decision : "view";
  return <div className="space-y-3" data-calendar-invitation-chat data-calendar-presentation>
    <CalendarInvitations key={`${applicationOwnerId}:${accountId}`} userId={applicationOwnerId} accountId={accountId} accountEmail={boundAccount} calendarPeople={calendarPeople} zone={typeof payload.timeZone === "string" ? payload.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"} getIdToken={() => owner.getIdToken()} initialFilter={String(payload.filter || "pending")} initialEventId={typeof payload.eventId === "string" ? payload.eventId : undefined} initialCalendarId={typeof payload.calendarId === "string" ? payload.calendarId : undefined} initialDecision={decision} initialTerms={terms} startAt={typeof payload.startAt === "string" ? payload.startAt : undefined} endAt={typeof payload.endAt === "string" ? payload.endAt : undefined} connectionRevision={revision} busy={busy} onConnect={(access, includeCalendarList) => connect("calendar", access, includeCalendarList)} onMailConnect={accountId === "default" ? () => connect("mail") : undefined} onBusyChange={value => { setActionBusy(value); onBusyChange?.(value); }} onResult={onResult} />
    <Button variant="ghost" size="compact" className={calendarPresentation.utility} disabled={actionBusy} onClick={onClose}>Close invitations</Button>
  </div>;
}
