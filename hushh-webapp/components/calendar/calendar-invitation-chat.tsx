"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import calendarPresentation from "./calendar-presentation.module.css";
import { connectCalendarInPlace, connectGmailInPlace, type InPlaceConnectOwner, type ConnectControls } from "@/lib/connections/google-connect-in-place";
import { snapshotValidatedAuthSessionPrincipal, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { GoogleCalendarService, type CalendarAttendanceResult } from "@/lib/services/google-calendar-service";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { CalendarInvitations } from "./calendar-invitations";
import type { InvitationDecision, InvitationTerms } from "./calendar-invitation-actions";

/** The shared Calendar controls stay in this chat; OAuth opens in place. */
export function CalendarInvitationChat({ owner, ownerId: applicationOwnerId, payload, expectedAccountEmail, onResult, onClose, onBusyChange, vaultOwnerCapability, confirmLegacyTransition }: { vaultOwnerCapability?: string | null; confirmLegacyTransition?: ConnectControls["confirmLegacyTransition"]; owner: InPlaceConnectOwner; ownerId: string; payload: Record<string, unknown>; expectedAccountEmail?: string; onResult: (result: CalendarAttendanceResult) => void; onClose: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [accountObservation, setAccountObservation] = useState<{ ownerId: string; email: string | null } | null>(null);
  const account = accountObservation?.ownerId === applicationOwnerId ? accountObservation.email : null;
  const lifetime = useRef<AbortController | null>(null);
  const binding = useRef({ ownerId: applicationOwnerId, capability: vaultOwnerCapability });
  binding.current = { ownerId: applicationOwnerId, capability: vaultOwnerCapability };
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => { controller.abort(); }; }, []);
  useEffect(() => {
    let active = true;
    const principal = snapshotValidatedAuthSessionPrincipal();
    const current = () => Boolean(active && principal && principal.firebaseUid === owner.uid
      && principal.ownerId === applicationOwnerId && isValidatedAuthSessionOwnerCurrent(principal));
    if (!current()) return;
    void owner.getIdToken().then(idToken => {
      if (!current()) throw new Error("OWNER_CHANGED");
      return GoogleCalendarService.status(idToken, applicationOwnerId);
    }).then(status => { if (current()) setAccountObservation({ ownerId: applicationOwnerId, email: status.google_email || null }); }).catch(() => { if (current()) setAccountObservation(previous => previous?.ownerId === applicationOwnerId ? previous : { ownerId: applicationOwnerId, email: null }); });
    return () => { active = false; };
  }, [owner, applicationOwnerId, revision]);
  const connect = (kind: "calendar" | "mail", access: "read" | "manage" = "manage", includeCalendarList = false) => {
    const controller = lifetime.current;
    const principal = snapshotValidatedAuthSessionPrincipal();
    if (busy || !controller || !principal || principal.firebaseUid !== owner.uid || principal.ownerId !== applicationOwnerId) return;
    const ownerId = applicationOwnerId, capability = vaultOwnerCapability, epoch = snapshotVaultSessionEpoch();
    const controls = { owner, signal: controller.signal, vaultOwnerCapability: capability, confirmLegacyTransition,
      isCurrent: () => isValidatedAuthSessionOwnerCurrent(principal) && lifetime.current === controller && !controller.signal.aborted &&
        binding.current.ownerId === ownerId && binding.current.capability === capability && isVaultSessionEpochCurrent(epoch) };
    const attempt = kind === "calendar" ? connectCalendarInPlace({ ...controls, accessLevel: access, includeCalendarList }) : connectGmailInPlace({ ...controls, purpose: "send" });
    setBusy(true);
    void attempt.result.then(result => { if (controls.isCurrent()) { if (result === "connected") setRevision(value => value + 1); else if (result !== "stale") morphyToast.error("Access was not updated. You can try again."); } }).finally(() => { if (controls.isCurrent()) setBusy(false); });
  };
  if (accountObservation?.ownerId !== applicationOwnerId) return <div><p role="status">Checking Calendar connection…</p><Button variant="ghost" size="compact" className={calendarPresentation.utility} onClick={onClose}>Close invitations</Button></div>;
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
    <CalendarInvitations userId={applicationOwnerId} accountEmail={boundAccount} zone={typeof payload.timeZone === "string" ? payload.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"} getIdToken={() => owner.getIdToken()} initialFilter={String(payload.filter || "pending")} initialEventId={typeof payload.eventId === "string" ? payload.eventId : undefined} initialCalendarId={typeof payload.calendarId === "string" ? payload.calendarId : undefined} initialDecision={decision} initialTerms={terms} startAt={typeof payload.startAt === "string" ? payload.startAt : undefined} endAt={typeof payload.endAt === "string" ? payload.endAt : undefined} connectionRevision={revision} busy={busy} onConnect={(access, includeCalendarList) => connect("calendar", access, includeCalendarList)} onMailConnect={() => connect("mail")} onBusyChange={value => { setActionBusy(value); onBusyChange?.(value); }} onResult={onResult} />
    <Button variant="ghost" size="compact" className={calendarPresentation.utility} disabled={actionBusy} onClick={onClose}>Close invitations</Button>
  </div>;
}
