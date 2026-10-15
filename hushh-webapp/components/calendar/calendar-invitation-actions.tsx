"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { notifyCalendarChanged } from "@/lib/calendar/calendar-refresh";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { GoogleCalendarService, GoogleCalendarError, type CalendarAttendanceResult, type CalendarAttendanceReview, type CalendarInvitation } from "@/lib/services/google-calendar-service";
import { calendarDate, eventTime, shiftCalendarDate, timeRangeLabel } from "./calendar-schedule-presentation";
import styles from "./calendar-invitations.module.css";

export type InvitationTerms = { date?: string; startTime?: string; endTime?: string; durationMinutes?: number; message?: string };
export type InvitationDecision = "view" | "accepted" | "declined" | "offer_times";
export function attendanceResultMessage(result: CalendarAttendanceResult) {
  const calendar = result.calendar === "accepted" ? "Your invitation was accepted." : result.calendar === "declined" ? "Your attendance was declined." : result.calendar === "tentative" ? "Your response is tentative." : result.calendar === "unknown" ? "Calendar response could not be confirmed. Check the invitation before trying again." : "Your Calendar response was not updated.";
  const mail = result.email === "sent" ? "The organizer's email was sent. They must confirm a new time and update their invitation." : result.email === "failed" ? "The organizer's email was not sent." : result.email === "unknown" ? "Email delivery could not be confirmed. Check Sent Mail before trying again." : "";
  return [calendar, result.calendar_error, mail, result.email_error].filter(Boolean).join(" ");
}

type Props = {
  event: CalendarInvitation; userId: string; token: string | null; zone: string; getIdToken: () => Promise<string>;
  expectedAccountEmail?: string | null; onBusyChange?: (busy: boolean) => void;
  initialTerms?: InvitationTerms; initialDecision?: InvitationDecision; onOfferTimes?: () => void; onResult?: (result: CalendarAttendanceResult) => void;
  onConnect: (access: "read" | "manage", includeCalendarList?: boolean) => void; onMailConnect?: () => void;
};

/** Page and Chat use this exact review/confirmation flow. Tokens stay in React memory. */
export function CalendarInvitationActions({ event, userId, token, zone, getIdToken, initialDecision = "view", initialTerms, expectedAccountEmail, onBusyChange, onOfferTimes, onResult, onConnect, onMailConnect }: Props) {
  const [decision, setDecision] = useState<InvitationDecision>(initialDecision);
  const [date, setDate] = useState(() => initialTerms?.date || shiftCalendarDate(calendarDate(Date.now(), zone), 1));
  const [startTime, setStartTime] = useState(initialTerms?.startTime || "09:00"), [endTime, setEndTime] = useState(initialTerms?.endTime || "17:00");
  const [message, setMessage] = useState(initialTerms?.message || "I can't attend our meeting. Please choose another time using the link below and update the invitation.");
  const [review, setReview] = useState<CalendarAttendanceReview | null>(null);
  const [result, setResult] = useState<CalendarAttendanceResult | null>(null);
  const [failure, setFailure] = useState<GoogleCalendarError | null>(null);
  const [busy, setBusy] = useState(false);
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  const flight = useRef(false), lifetime = useRef({ current: 0 });
  useEffect(() => { const scope = lifetime.current; scope.current++; return () => { scope.current++; busyCallback.current?.(false); }; }, []);
  const [duration, setDuration] = useState(() => initialTerms?.durationMinutes || (event.start?.dateTime && event.end?.dateTime ? Math.round((Date.parse(event.end.dateTime) - Date.parse(event.start.dateTime)) / 60000) : 30));
  const offer = decision === "offer_times";
  const run = async (work: (current: () => boolean) => Promise<void>) => {
    if (flight.current) return;
    const epoch = snapshotVaultSessionEpoch(), mounted = lifetime.current.current;
    const current = () => isVaultSessionEpochCurrent(epoch) && mounted === lifetime.current.current;
    flight.current = true; setBusy(true); busyCallback.current?.(true); setFailure(null);
    try { await work(current); }
    catch (error) {
      if (current()) {
        const failure = error instanceof GoogleCalendarError ? error : new GoogleCalendarError("Calendar could not complete this request. Please try again.", null, 503);
        setFailure(failure);
        // A row action uses the shared transient feedback owner.
        morphyToast.error(failure.message);
      }
    } finally { flight.current = false; if (current()) { setBusy(false); busyCallback.current?.(false); } }
  };
  const prepare = (next: InvitationDecision) => run(async current => {
    setDecision(next); setReview(null); setResult(null);
    if (!token) throw new GoogleCalendarError("Unlock your vault before changing your response.", "calendar_owner_required", 401);
    const firebaseIdToken = await getIdToken();
    if (!current()) return;
    const prepared = await GoogleCalendarService.reviewAttendance({ firebaseIdToken, vaultOwnerToken: token, eventId: event.id, calendarId: event.calendar_id, expectedAccountEmail: expectedAccountEmail || undefined, responseStatus: next === "accepted" ? "accepted" : "declined", offerTimes: next === "offer_times", message, date, timeZone: zone, startTime, endTime, durationMinutes: Math.max(1, Math.min(1440, duration)), isEffectCurrent: current });
    if (current()) setReview(prepared);
  });
  const confirm = () => run(async current => {
    if (!token || !review) return;
    const firebaseIdToken = await getIdToken();
    if (!current()) return;
    const confirmation = GoogleCalendarService.confirmAttendance({ firebaseIdToken, vaultOwnerToken: token, reviewId: review.review_id, reviewToken: review.review_token, isEffectCurrent: current });
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
  });
  const edit = () => { setReview(null); setResult(null); };
  return <div className={styles.actions} aria-label="Invitation actions" aria-busy={busy}>
    {result ? <div className={styles.review} role="status"><p>{attendanceResultMessage(result)}</p><Button variant="outline" onClick={() => { setResult(null); setDecision("view"); }}>Done</Button></div> : review ? <div className={styles.review}>
      <h3>{review.response_status === "accepted" ? "Accept invitation?" : "Decline invitation?"}</h3><p>{review.title}</p><p className={styles.muted}>{eventTime(event, zone)}</p>
      {review.conflicts?.length ? <div className={styles.conflict} role="alert"><AlertTriangle aria-hidden className="size-4 shrink-0" /><div><strong>This overlaps another meeting</strong>{review.conflicts.map((conflict, index) => <p key={index}>{conflict.title} · {eventTime(conflict, zone)}</p>)}</div></div> : null}
      {review.unchecked_calendars?.length ? <p role="alert">Some calendars could not be checked for conflicts.</p> : null}
      {review.recipient ? <><p className={styles.muted}>To: {review.recipient}</p><p>{review.subject}</p><p className={styles.message}>{review.message}</p><ul className={styles.openings}>{review.openings?.map(slot => <li key={slot.start_at}>{new Date(slot.start_at).toLocaleDateString(undefined, { timeZone: zone, dateStyle: "medium" })} · {timeRangeLabel(slot.start_at, slot.end_at, zone)}</li>)}</ul><p className={styles.muted}>The organizer must confirm a new time and update their invitation.</p></> : null}
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void confirm()}>{busy ? "Confirming…" : offer ? "Confirm decline & send email" : review.response_status === "accepted" ? review.conflicts?.length ? "Accept anyway" : "Confirm accept" : "Confirm decline"}</Button><Button disabled={busy} variant="outline" onClick={edit}>Edit</Button></div>
    </div> : offer && !onOfferTimes ? <div className={styles.review}>
      <h3>Offer another time</h3><p className={styles.muted}>Choose a window to check your real availability.</p>
      <div className="grid grid-cols-2 gap-3"><label className="col-span-2 space-y-1"><span>Date</span><Input aria-label="Alternative date" type="date" value={date} onChange={e => { setDate(e.target.value); edit(); }} /></label><label className="space-y-1"><span>From</span><Input aria-label="Alternative start time" type="time" value={startTime} onChange={e => { setStartTime(e.target.value); edit(); }} /></label><label className="space-y-1"><span>Until</span><Input aria-label="Alternative end time" type="time" value={endTime} onChange={e => { setEndTime(e.target.value); edit(); }} /></label></div>
      <label className="block space-y-1"><span>Meeting length (minutes)</span><Input aria-label="Alternative duration in minutes" type="number" min={1} max={1440} value={duration} onChange={e => { setDuration(Number(e.target.value)); edit(); }} /></label>
      <label className="block space-y-1"><span>Message to organiser</span><Textarea aria-label="Message to organiser" value={message} maxLength={8000} onChange={e => { setMessage(e.target.value); edit(); }} /></label>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !token || !date || startTime >= endTime || duration < 1 || duration > 1440} onClick={() => void prepare("offer_times")}>{busy ? "Checking availability…" : "Check times & review message"}</Button><Button disabled={busy} variant="outline" onClick={() => setDecision("view")}>Back</Button></div>
    </div> : <>
      {initialDecision !== "view" ? <p className={styles.muted}>Review your {initialDecision === "accepted" ? "accept" : "decline"} response before confirming.</p> : null}
      <div className={styles.actionPair}><Button data-voice-control-id="calendar_invitation_accept" disabled={busy || !token || !event.can_respond || event.response_status === "accepted"} onClick={() => void prepare("accepted")}><CheckCircle aria-hidden className="size-4" />Accept</Button><Button data-voice-control-id="calendar_invitation_decline" disabled={busy || !token || !event.can_respond || event.response_status === "declined"} variant="outline" onClick={() => void prepare("declined")}><X aria-hidden className="size-4" />Decline</Button></div>
      <Button data-voice-control-id="calendar_invitation_offer" disabled={busy || !token || !event.can_respond} className={styles.offerButton} variant="outline" onClick={() => { if (onOfferTimes) onOfferTimes(); else { setDecision("offer_times"); edit(); } }}><CalendarClock aria-hidden className="size-4 shrink-0" />Decline & offer another time</Button>
    </>}
    {!event.can_respond ? <p className={styles.muted}>This calendar only allows viewing. Respond from your own Calendar invitation.</p> : null}
    {!token ? <p className={styles.muted}>Unlock your vault to respond to this invitation.</p> : null}
    {failure?.recovery === "permission" || failure?.recovery === "reconnect" || failure?.recovery === "connect" ? <Button variant="outline" disabled={busy} onClick={() => onConnect(failure.reasonCode === "calendar_list_permission_required" ? "read" : "manage", failure.reasonCode === "calendar_list_permission_required")}>Allow Calendar access</Button> : null}
    {failure?.reasonCode?.startsWith("GMAIL") && onMailConnect ? <Button disabled={busy} variant="outline" onClick={onMailConnect}>Enable Mail sending</Button> : null}
  </div>;
}
