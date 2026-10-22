"use client";

import type { CalendarAttendanceHandoff } from "@/lib/calendar/calendar-invitation-handoff";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { notifyCalendarChanged } from "@/lib/calendar/calendar-refresh";
import { MAX_CALENDAR_DECLINE_REASON_LENGTH, calendarDeclineMessage, sameCalendarInvitationOccurrence } from "@/lib/calendar/calendar-recipient-copy";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { GoogleCalendarService, GoogleCalendarError, type CalendarAttendanceResult, type CalendarAttendanceReview, type CalendarInvitation } from "@/lib/services/google-calendar-service";
import { calendarDate, eventTime, shiftCalendarDate, timeRangeLabel } from "./calendar-schedule-presentation";
import styles from "./calendar-invitations.module.css";

export type InvitationTerms = { date?: string; startTime?: string; endTime?: string; durationMinutes?: number; message?: string };
export type InvitationDecision = "view" | "accepted" | "declined" | "offer_times";
export function attendanceResultMessage(result: CalendarAttendanceResult) {
  const calendar = result.calendar === "accepted" ? "Your invitation was accepted." : result.calendar === "declined" ? "Your attendance was declined." : result.calendar === "tentative" ? "Your response is tentative." : result.calendar === "unknown" ? "Calendar response could not be confirmed. Check the invitation before trying again." : "Your Calendar response was not updated.";
  const mail = result.email === "sent" ? "Your email was sent to the organizer." : result.email === "failed" ? "The organizer's email was not sent." : result.email === "unknown" ? "Email delivery could not be confirmed. Check Sent Mail before trying again." : "";
  return [calendar, result.calendar_error, mail, result.email_error].filter(Boolean).join(" ");
}

type Props = {
  event: CalendarInvitation; userId: string; token: string | null; zone: string; getIdToken: () => Promise<string>;
  accountId?: string;
  expectedAccountEmail?: string | null; onBusyChange?: (busy: boolean) => void;
  onSend?: (handoff: CalendarAttendanceHandoff) => void;
  initialTerms?: InvitationTerms; initialDecision?: InvitationDecision; onOfferTimes?: () => void; onResult?: (result: CalendarAttendanceResult) => void;
  onConnect: (access: "read" | "manage", includeCalendarList?: boolean) => void; onMailConnect?: () => void;
};

/** Page and Chat use this exact review/confirmation flow. Tokens stay in React memory. */
export function CalendarInvitationActions({ event, userId, token, zone, getIdToken, accountId = "default", initialDecision = "view", initialTerms, expectedAccountEmail, onBusyChange, onOfferTimes, onSend, onResult, onConnect, onMailConnect }: Props) {
  const [decision, setDecision] = useState<InvitationDecision>(initialDecision);
  const [date, setDate] = useState(() => initialTerms?.date || shiftCalendarDate(calendarDate(Date.now(), zone), 1));
  const [startTime, setStartTime] = useState(initialTerms?.startTime || "09:00"), [endTime, setEndTime] = useState(initialTerms?.endTime || "17:00");
  const [message, setMessage] = useState(initialTerms?.message || "");
  const [review, setReview] = useState<CalendarAttendanceReview | null>(null);
  const [result, setResult] = useState<CalendarAttendanceResult | null>(null);
  const [failure, setFailure] = useState<GoogleCalendarError | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewRequired, setReviewRequired] = useState(false);
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  const handedOff = useRef(false);
  const flight = useRef(false), lifetime = useRef({ current: 0 });
  useEffect(() => { const scope = lifetime.current; scope.current++; return () => { scope.current++; busyCallback.current?.(false); }; }, []);
  const duration = event.start?.dateTime && event.end?.dateTime ? Math.round((Date.parse(event.end.dateTime) - Date.parse(event.start.dateTime)) / 60000) : 30;
  const offer = decision === "offer_times";
  const run = async (work: (current: () => boolean) => Promise<void>) => {
    if (flight.current || handedOff.current) return;
    const epoch = snapshotVaultSessionEpoch(), mounted = lifetime.current.current;
    const current = () => isVaultSessionEpochCurrent(epoch) && mounted === lifetime.current.current;
    flight.current = true; setBusy(true); busyCallback.current?.(true); setFailure(null);
    try { await work(current); }
    catch (error) {
      if (current()) {
        const failure = error instanceof GoogleCalendarError ? error : new GoogleCalendarError("Calendar could not complete this request. Please try again.", null, 503);
        setFailure(failure);
        if (failure.reasonCode === "calendar_review_expired") { setReview(null); setReviewRequired(true); }
        // A row action uses the shared transient feedback owner.
        morphyToast.error(failure.message);
      }
    } finally { flight.current = false; if (current() && !handedOff.current) { setBusy(false); busyCallback.current?.(false); } }
  };
  const prepare = (next: InvitationDecision, send = false) => run(async current => {
    setDecision(next); setReview(null); setResult(null);
    if (!token) throw new GoogleCalendarError("Unlock your vault before changing your response.", "calendar_owner_required", 401);
    const firebaseIdToken = await getIdToken();
    if (!current()) return;
    const clockMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const proposedEndTime = endTime === "00:00" ? "24:00" : endTime;
    const outgoingMessage = next === "declined" && send && !onSend ? calendarDeclineMessage(event, zone, message) : message;
    const prepared = await GoogleCalendarService.reviewAttendance({
      firebaseIdToken, vaultOwnerToken: token, eventId: event.id, calendarId: event.calendar_id, accountId,
      expectedAccountEmail: expectedAccountEmail || undefined,
      responseStatus: next === "accepted" ? "accepted" : "declined",
      offerTimes: next === "offer_times", exactTime: next === "offer_times",
      sendMessage: next === "declined" || next === "offer_times",
      message: outgoingMessage, date, timeZone: zone, startTime, endTime: proposedEndTime,
      // The service derives elapsed duration in the selected zone, including DST.
      durationMinutes: next === "offer_times" ? Math.max(1, clockMinutes(proposedEndTime) - clockMinutes(startTime)) : Math.max(1, Math.min(1440, duration)),
      isEffectCurrent: current,
    });
    if (!current()) return;
    if (send && !prepared.recipient) throw new GoogleCalendarError("The organizer email could not be prepared. Nothing was sent. Try again after updating Calendar.", "calendar_mail_review_required", 409);
    if (next === "declined" && send && !onSend && !sameCalendarInvitationOccurrence(event, prepared)) {
      throw new GoogleCalendarError("This invitation changed while the email was prepared. Refresh Calendar and review it again; nothing was sent.", "calendar_event_changed", 409);
    }
    setReview(prepared);
    if (send && (next !== "declined" || onSend) && prepared.recipient?.toLowerCase() === event.organizer?.email?.toLowerCase() && !reviewRequired && !prepared.conflicts?.length && !prepared.unchecked_calendars?.length) await execute(prepared, current);
  });
  const execute = async (review: CalendarAttendanceReview, current: () => boolean) => {
    if (!token) return;
    const firebaseIdToken = await getIdToken();
    if (!current()) return;
    const epoch = snapshotVaultSessionEpoch();
    const confirmation = GoogleCalendarService.confirmAttendance({ firebaseIdToken, vaultOwnerToken: token, accountId, reviewId: review.review_id, reviewToken: review.review_token, isEffectCurrent: onSend ? () => isVaultSessionEpochCurrent(epoch) : current });
    if (onSend && review.recipient) {
      const outcome = confirmation.then(result => {
        if (isVaultSessionEpochCurrent(epoch) && ["accepted", "declined", "tentative"].includes(result.calendar)) notifyCalendarChanged(userId);
        return { result };
      }).catch(error => ({ error: error instanceof Error ? error.message : "The response could not be confirmed. Check Calendar and Sent Mail before retrying." }));
      handedOff.current = true;
      onSend({ ownerId: userId, epoch, title: review.title, recipient: review.recipient, outcome });
      return;
    }
    // Settlement owns the feedback; the inline result retains partial outcomes.
    const feedback = confirmation.then(response => {
      if (["failed", "unknown"].includes(response.calendar) || ["failed", "unknown"].includes(response.email)) throw new Error(attendanceResultMessage(response));
      return response;
    });
    morphyToast.promise(feedback, { loading: "Updating your invitation…", success: response => attendanceResultMessage(response), error: error => error instanceof Error ? error.message : "Your response could not be confirmed." });
    const response = await confirmation;
    if (!current()) return;
    if (!["accepted", "declined", "tentative", "failed", "unknown"].includes(response.calendar) || !["sent", "not_sent", "failed", "unknown"].includes(response.email)) throw new GoogleCalendarError("Calendar did not confirm the outcome. Check the invitation before retrying.", null, 502);
    setReview(null); setResult(response);
    if (["accepted", "declined", "tentative"].includes(response.calendar)) notifyCalendarChanged(userId);
    onResult?.(response);
  };
  const confirm = () => run(async current => { if (review) await execute(review, current); });
  const edit = () => { setReview(null); setResult(null); };
  return <div className={styles.actions} aria-label="Invitation actions" aria-busy={busy}>
    {result ? <div className={styles.review} role="status"><p>{attendanceResultMessage(result)}</p><Button variant="outline" onClick={() => { setResult(null); setDecision("view"); }}>Done</Button></div> : review ? <div className={styles.review}>
      <h3>{review.response_status === "accepted" ? "Accept invitation?" : "Decline invitation?"}</h3><p>{review.title}</p><p className={styles.muted}>{eventTime(event, zone)}</p>
      {review.conflicts?.length ? <div className={styles.conflict} role="alert"><AlertTriangle aria-hidden className="size-4 shrink-0" /><div><strong>This time is already booked</strong>{review.conflicts.map((conflict, index) => <p key={index}>{conflict.title} · {eventTime(conflict, zone)}</p>)}</div></div> : null}
      {review.unchecked_calendars?.length ? <p role="alert">Some calendars could not be checked for conflicts.</p> : null}
      {review.recipient ? <><p className={styles.muted}>To: {review.recipient}</p><p>{review.subject}</p><p className={styles.message}>{review.message}</p><ul className={styles.openings}>{review.openings?.map(slot => <li key={slot.start_at}>{new Date(slot.start_at).toLocaleDateString(undefined, { timeZone: zone, dateStyle: "medium" })} · {timeRangeLabel(slot.start_at, slot.end_at, zone)}</li>)}</ul>{offer ? <p className={styles.muted}>The organizer must confirm the proposed time and update their invitation.</p> : null}</> : null}
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void confirm()}>{busy ? "Confirming…" : review.recipient ? review.conflicts?.length ? "Continue & send email" : "Decline & send email" : review.response_status === "accepted" ? review.conflicts?.length ? "Accept anyway" : "Confirm accept" : "Confirm decline"}</Button><Button disabled={busy} variant="outline" onClick={edit}>{review.conflicts?.length ? "Change time" : "Edit"}</Button></div>
    </div> : offer && !onOfferTimes ? <div className={styles.review}>
      <h3>Offer another time</h3><p className={styles.muted}>Choose the exact time to propose. The duration is calculated automatically.</p>
      <div className="grid grid-cols-2 gap-3"><label className="col-span-2 space-y-1"><span>Date</span><Input disabled={busy} aria-label="Alternative date" type="date" value={date} onChange={e => { setDate(e.target.value); edit(); }} /></label><label className="space-y-1"><span>From</span><Input disabled={busy} aria-label="Alternative start time" type="time" value={startTime} onChange={e => { setStartTime(e.target.value); edit(); }} /></label><label className="space-y-1"><span>Until</span><Input disabled={busy} aria-label="Alternative end time" type="time" value={endTime} onChange={e => { setEndTime(e.target.value); edit(); }} /></label></div>
      <label className="block space-y-1"><span>Reason and message to organiser</span><Textarea disabled={busy} aria-label="Message to organiser" value={message} maxLength={8000} onChange={e => { setMessage(e.target.value); edit(); }} /></label>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !token || !date || (endTime !== "00:00" && startTime >= endTime) || !message.trim()} onClick={() => void prepare("offer_times", true)}>{busy ? "Checking availability…" : reviewRequired ? "Review again" : "Check time & send email"}</Button><Button disabled={busy} variant="outline" onClick={() => setDecision("view")}>Back</Button></div>
    </div> : decision === "declined" ? <div className={styles.review}>
      <h3>Why can’t you attend?</h3>
      <p className={styles.muted}>{onSend ? `Your reason will be emailed to ${event.organizer?.email || "the organizer"} when you choose Decline & send email.` : `Review the email to ${event.organizer?.email || "the organizer"} before sending.`}</p>
      <label className="block space-y-1"><span>Reason for declining</span><Textarea disabled={busy} aria-label="Reason for declining" value={message} maxLength={onSend ? 8000 : MAX_CALENDAR_DECLINE_REASON_LENGTH} onChange={e => { setMessage(e.target.value); edit(); }} /></label>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !token || !message.trim() || (!onSend && message.length > MAX_CALENDAR_DECLINE_REASON_LENGTH)} onClick={() => void prepare("declined", true)}>{busy ? "Preparing…" : reviewRequired ? "Review again" : onSend ? "Decline & send email" : "Review decline email"}</Button><Button disabled={busy} variant="outline" onClick={() => setDecision("view")}>Back</Button></div>
    </div> : <>
      {initialDecision !== "view" ? <p className={styles.muted}>Review your {initialDecision === "accepted" ? "accept" : "decline"} response before confirming.</p> : null}
      <div className={styles.actionPair}><Button data-voice-control-id="calendar_invitation_accept" disabled={busy || !token || !event.can_respond || event.response_status === "accepted"} onClick={() => void prepare("accepted")}><CheckCircle aria-hidden className="size-4" />Accept</Button><Button data-voice-control-id="calendar_invitation_decline" disabled={busy || !token || !event.can_respond || event.response_status === "declined"} variant="outline" onClick={() => { setDecision("declined"); edit(); }}><X aria-hidden className="size-4" />Decline</Button></div>
      <Button data-voice-control-id="calendar_invitation_offer" disabled={busy || !token || !event.can_respond} className={styles.offerButton} variant="outline" onClick={() => { if (onOfferTimes) onOfferTimes(); else { setDecision("offer_times"); edit(); } }}><CalendarClock aria-hidden className="size-4 shrink-0" />Decline & offer another time</Button>
    </>}
    {failure ? <p role="alert">{failure.message}</p> : null}
    {!event.can_respond ? <p className={styles.muted}>This calendar only allows viewing. Respond from your own Calendar invitation.</p> : null}
    {!token ? <p className={styles.muted}>Unlock your vault to respond to this invitation.</p> : null}
    {failure?.recovery === "permission" || failure?.recovery === "reconnect" || failure?.recovery === "connect" ? <Button variant="outline" disabled={busy} onClick={() => onConnect(failure.reasonCode === "calendar_list_permission_required" ? "read" : "manage", failure.reasonCode === "calendar_list_permission_required")}>Allow Calendar access</Button> : null}
    {failure?.reasonCode?.startsWith("GMAIL") && onMailConnect ? <Button disabled={busy} variant="outline" onClick={onMailConnect}>Enable Mail sending</Button> : null}
  </div>;
}
