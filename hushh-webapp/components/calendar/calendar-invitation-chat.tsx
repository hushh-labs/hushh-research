"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { connectCalendarInPlace, connectGmailInPlace, type InPlaceConnectOwner } from "@/lib/connections/google-connect-in-place";
import { GoogleCalendarService, type CalendarAttendanceResult } from "@/lib/services/google-calendar-service";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { CalendarInvitations } from "./calendar-invitations";
import type { InvitationDecision, InvitationTerms } from "./calendar-invitation-actions";

/** The shared Calendar controls stay in this chat; OAuth opens in place. */
export function CalendarInvitationChat({ owner, payload, expectedAccountEmail, onResult, onClose, onBusyChange }: { owner: InPlaceConnectOwner; payload: Record<string, unknown>; expectedAccountEmail?: string; onResult: (result: CalendarAttendanceResult) => void; onClose: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => { controller.abort(); }; }, []);
  useEffect(() => {
    let active = true;
    void owner.getIdToken().then(idToken => GoogleCalendarService.status(idToken, owner.uid)).then(status => { if (active) setAccount(status.google_email || null); }).catch(() => {});
    return () => { active = false; };
  }, [owner, revision]);
  const connect = (kind: "calendar" | "mail", access: "read" | "manage" = "manage", includeCalendarList = false) => {
    if (busy) return;
    const controls = { owner, signal: lifetime.current?.signal, isCurrent: () => !lifetime.current?.signal.aborted };
    const attempt = kind === "calendar" ? connectCalendarInPlace({ ...controls, accessLevel: access, includeCalendarList }) : connectGmailInPlace({ ...controls, purpose: "send" });
    setBusy(true);
    void attempt.result.then(result => { if (controls.isCurrent()) { if (result === "connected") setRevision(value => value + 1); else if (result !== "stale") morphyToast.error("Access was not updated. You can try again."); } }).finally(() => { if (controls.isCurrent()) setBusy(false); });
  };
  const boundAccount = expectedAccountEmail || (typeof payload.accountEmail === "string" ? payload.accountEmail : account);
  if (boundAccount && account && boundAccount.toLowerCase() !== account.toLowerCase()) return <div role="alert"><p>The connected Calendar account changed. Close this review and ask One to check the invitation again.</p><Button variant="ghost" onClick={onClose}>Close invitations</Button></div>;
  const rawTerms = payload.terms && typeof payload.terms === "object" ? payload.terms as Record<string, unknown> : {};
  const terms: InvitationTerms = {
    date: typeof rawTerms.date === "string" ? rawTerms.date : undefined,
    startTime: typeof rawTerms.startTime === "string" ? rawTerms.startTime : undefined,
    endTime: typeof rawTerms.endTime === "string" ? rawTerms.endTime : undefined,
    durationMinutes: typeof rawTerms.durationMinutes === "number" ? rawTerms.durationMinutes : undefined,
    message: typeof rawTerms.message === "string" ? rawTerms.message : undefined,
  };
  const decision: InvitationDecision = payload.decision === "accepted" || payload.decision === "declined" || payload.decision === "offer_times" ? payload.decision : "view";
  return <div className="space-y-3" data-calendar-invitation-chat>
    <CalendarInvitations userId={owner.uid} accountEmail={boundAccount} zone={typeof payload.timeZone === "string" ? payload.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"} getIdToken={() => owner.getIdToken()} initialFilter={String(payload.filter || "pending")} initialEventId={typeof payload.eventId === "string" ? payload.eventId : undefined} initialCalendarId={typeof payload.calendarId === "string" ? payload.calendarId : undefined} initialDecision={decision} initialTerms={terms} startAt={typeof payload.startAt === "string" ? payload.startAt : undefined} endAt={typeof payload.endAt === "string" ? payload.endAt : undefined} connectionRevision={revision} busy={busy} onConnect={(access, includeCalendarList) => connect("calendar", access, includeCalendarList)} onMailConnect={() => connect("mail")} onBusyChange={value => { setActionBusy(value); onBusyChange?.(value); }} onResult={onResult} />
    <Button variant="ghost" disabled={actionBusy} onClick={onClose}>Close invitations</Button>
  </div>;
}
