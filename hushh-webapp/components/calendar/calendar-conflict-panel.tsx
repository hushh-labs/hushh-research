"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { CalendarCompactAction } from "./calendar-compact-action";
import presentationStyles from "./calendar-presentation.module.css";
import { Textarea } from "@/components/ui/textarea";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { GoogleCalendarService, GoogleCalendarError, type CalendarAttendanceResult, type CalendarAttendanceReview, type CalendarBoardDay, type CalendarConflictReview, type CalendarConflictResult, type CalendarEventRef, type CalendarEventSummary } from "@/lib/services/google-calendar-service";
import { eventTime } from "./calendar-schedule-presentation";
import { MAX_CALENDAR_DECLINE_REASON_LENGTH, calendarDeclineMessage, sameCalendarInvitationOccurrence } from "@/lib/calendar/calendar-recipient-copy";
import styles from "./calendar-account-board.module.css";

type Choice = { ref: CalendarEventRef; event: CalendarEventSummary; email: string; canDecline: boolean };
const key = (ref: CalendarEventRef) => `${ref.account_id}\u001f${ref.calendar_id}\u001f${ref.event_id}`;

export function CalendarConflictPanel({ board, keep, getIdToken, initialDraft, onDraftChange, onDone, onConfirmed, onBusyChange, onChooseKeep, onMailConnect }: {
  board: CalendarBoardDay;
  keep: CalendarEventRef;
  getIdToken: () => Promise<string>;
  initialDraft: { selected: string[]; notes: Record<string, string> };
  onDraftChange: (draft: { selected: string[]; notes: Record<string, string> }) => void;
  onDone: () => void;
  onConfirmed: () => void;
  onBusyChange: (busy: boolean) => void;
  onChooseKeep: (ref: CalendarEventRef) => void;
  onMailConnect?: () => Promise<void>;
}) {
  const keptAccount = board.accounts.find(account => account.account_id === keep.account_id);
  const keptEvent = keptAccount?.events.find(event => event.calendar_id === keep.calendar_id && event.id === keep.event_id);
  const choices: Choice[] = [];
  const seen = new Set<string>();
  for (const pair of board.conflicts) {
    const other = key(pair.left) === key(keep) ? pair.right : key(pair.right) === key(keep) ? pair.left : null;
    if (!other || seen.has(key(other))) continue;
    seen.add(key(other));
    const account = board.accounts.find(item => item.account_id === other.account_id);
    const event = account?.events.find(item => item.calendar_id === other.calendar_id && item.id === other.event_id);
    if (account && event) choices.push({ ref: other, event, email: account.google_email, canDecline: event.can_decline === true });
  }
  const [selected, setSelected] = useState<string[]>(() => initialDraft.selected.filter(item => choices.some(choice => key(choice.ref) === item)));
  const [notes, setNotes] = useState<Record<string, string>>(() => initialDraft.notes);
  const [review, setReview] = useState<CalendarConflictReview | null>(null);
  const [result, setResult] = useState<CalendarConflictResult | null>(null);
  const [retryTarget, setRetryTarget] = useState<CalendarEventRef | null>(null);
  const [retryReview, setRetryReview] = useState<CalendarAttendanceReview | null>(null);
  const [retryResults, setRetryResults] = useState<Record<string, CalendarAttendanceResult>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const flight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onBusyChange(false); }; }, [onBusyChange]);
  const resetReview = () => { setReview(null); setResult(null); setError(null); };

  const execute = async (operation: () => Promise<void>) => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true); onBusyChange(true); setError(null);
    try { await operation(); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure : new Error("Calendar could not confirm this action.")); }
    finally { flight.current = false; if (mounted.current) { setBusy(false); onBusyChange(false); } }
  };

  const prepare = () => void execute(async () => {
    if (!board.complete || !board.conflicts_complete) throw new Error("Refresh every account before resolving conflicts.");
    const owner = snapshotValidatedAuthSessionOwner();
    const current = () => mounted.current && (!owner || isValidatedAuthSessionOwnerCurrent(owner));
    const firebaseIdToken = await getIdToken();
    if (!current()) return;
    const decline = choices.filter(choice => selected.includes(key(choice.ref))).map(choice => ({
      ...choice.ref,
      message: calendarDeclineMessage(choice.event, board.time_zone, notes[key(choice.ref)]?.trim() || ""),
      reason: notes[key(choice.ref)]?.trim() || "",
    }));
    const next = await GoogleCalendarService.reviewWorkspaceConflict({
      firebaseIdToken, date: board.date, timeZone: board.time_zone,
      keep, decline, isEffectCurrent: current,
    });
    for (const choice of choices.filter(item => selected.includes(key(item.ref)))) {
      const preview = next.previews.find(item => item.kind === "decline" && key(item.ref) === key(choice.ref));
      if (!preview || !sameCalendarInvitationOccurrence(choice.event, preview)) {
        throw new Error("An invitation changed while the email was prepared. Refresh Calendar and review it again; nothing was sent.");
      }
    }
    if (current()) setReview(next);
  });

  const confirm = () => void execute(async () => {
    if (!review) return;
    const owner = snapshotValidatedAuthSessionOwner();
    const current = () => mounted.current && (!owner || isValidatedAuthSessionOwnerCurrent(owner));
    const firebaseIdToken = await getIdToken();
    if (!current()) return;
    const next = await GoogleCalendarService.confirmWorkspaceConflict({
      firebaseIdToken, reviewId: review.review_id,
      reviewToken: review.review_token,
      isEffectCurrent: current,
    });
    if (current()) { setResult(next); onConfirmed(); }
  });

  const prepareRetry = (ref: CalendarEventRef) => void execute(async () => {
    if (!review) return;
    const preview = review.previews.find(item => item.kind === "decline" && key(item.ref) === key(ref));
    if (!preview?.message) throw new Error("The reviewed organizer note is unavailable. Refresh and review again.");
    const account = board.accounts.find(item => item.account_id === ref.account_id);
    if (!account) throw new Error("The Calendar account is unavailable.");
    const owner = snapshotValidatedAuthSessionOwner();
    const current = () => mounted.current && (!owner || isValidatedAuthSessionOwnerCurrent(owner));
    const firebaseIdToken = await getIdToken();
    if (!current()) return;
    const prepared = await GoogleCalendarService.reviewWorkspaceAttendance({
      firebaseIdToken, accountId: ref.account_id,
      expectedAccountEmail: account.google_email, eventId: ref.event_id,
      calendarId: ref.calendar_id, responseStatus: "declined", sendMessage: true,
      offerTimes: false, exactTime: false, mailOnlyRetry: true, message: preview.message,
      date: board.date, timeZone: board.time_zone, startTime: "00:00", endTime: "24:00",
      durationMinutes: 30,
      isEffectCurrent: current,
    });
    const original = choices.find(choice => key(choice.ref) === key(ref))?.event;
    if (!original || !sameCalendarInvitationOccurrence(original, prepared) || prepared.message !== preview.message) {
      throw new Error("This invitation changed since the earlier review. Refresh Calendar and check the organizer note again; nothing was sent.");
    }
    if (current()) {
      setRetryTarget(ref); setRetryReview(prepared);
    }
  });

  const confirmRetry = () => void execute(async () => {
    if (!retryReview || !retryTarget) return;
    const owner = snapshotValidatedAuthSessionOwner();
    const current = () => mounted.current && (!owner || isValidatedAuthSessionOwnerCurrent(owner));
    const firebaseIdToken = await getIdToken();
    if (!current()) return;
    const outcome = await GoogleCalendarService.confirmWorkspaceAttendance({
      firebaseIdToken, accountId: retryTarget.account_id,
      reviewId: retryReview.review_id, reviewToken: retryReview.review_token,
      isEffectCurrent: current,
    });
    if (current()) {
      setRetryResults(current => ({ ...current, [key(retryTarget)]: outcome })); setRetryReview(null);
    }
  });

  const retryOutcome = retryTarget ? retryResults[key(retryTarget)] : null;
  return <section className={styles.conflictPanel} aria-label="Resolve overlapping meetings" aria-busy={busy}>
    {result ? <>
      <h3>Calendar and Mail outcomes</h3>
      <p role="status">{result.complete ? "Selected changes were confirmed." : "Some steps did not finish. Check each result before another review."}</p>
      <ul className={styles.outcomeList}>{result.results.map(item => {
        const choice = item.kind === "keep" ? keptEvent : choices.find(value => key(value.ref) === key(item.ref))?.event;
        return <li key={`${item.kind}:${key(item.ref)}`}><strong>{choice?.title || "Meeting"}</strong><span>Calendar: {item.calendar} · Mail: {item.email}</span>{item.calendar_error || item.email_error || item.error ? <p role="alert">{item.calendar_error || item.email_error || item.error}</p> : null}</li>;
      })}</ul>
      {!result.complete ? <p className={styles.readOnly}>Completed steps will not be sent again by this review. Refresh the board before preparing any remaining action; verify unknown outcomes in Calendar and Sent Mail first.</p> : null}
      {!retryReview ? result.results.filter(item => item.kind === "decline" && item.calendar === "declined" && (retryResults[key(item.ref)]?.email || item.email) === "failed").map(item => <CalendarCompactAction key={`retry:${key(item.ref)}`} disabled={busy} onClick={() => prepareRetry(item.ref)}>Review email retry for {review?.previews.find(preview => key(preview.ref) === key(item.ref))?.title || "meeting"}</CalendarCompactAction>) : null}
      {retryReview ? <div className={styles.mailPreview}><h4>Review email retry</h4><p>Calendar attendance is already declined. Only this reviewed note will be sent.</p><p>From: {retryReview.sender_label}</p><p>To: {retryReview.recipient}</p><p>Subject: {retryReview.subject}</p><p className={styles.notePreview}>{retryReview.message}</p><Button disabled={busy || Date.parse(retryReview.expires_at) <= Date.now()} onClick={confirmRetry}>Send reviewed note</Button></div> : null}
      {retryOutcome ? <p role="status">Email retry: {retryOutcome.email}. Calendar: {retryOutcome.calendar}.{retryOutcome.email_error ? ` ${retryOutcome.email_error}` : ""}</p> : null}
      <Button variant="ghost" size="compact" className={presentationStyles.utility} onClick={onDone}>Done</Button>
    </> : review ? <>
      <h3>Review before changing meetings</h3>
      <p>Each Calendar response and organizer email is listed separately. These actions cannot be undone together.</p>
      <ul className={styles.previewList}>{review.previews.map(item => <li key={`${item.kind}:${key(item.ref)}`}>
        <strong>{item.action}: {item.title}</strong>
        <span>{item.account_email} · {itemTime(item, board.time_zone)}</span>
        {item.kind === "decline" ? <div className={styles.mailPreview}><p>From: {item.sender_label}</p><p>To: {item.recipient}</p><p>Subject: {item.subject}</p><p className={styles.notePreview}>{item.message}</p></div> : null}
      </li>)}</ul>
      <div className={styles.conflictActions}><Button variant="ghost" size="compact" className={presentationStyles.utility} disabled={busy} onClick={resetReview}>Edit choices</Button><Button disabled={busy || Date.parse(review.expires_at) <= Date.now()} onClick={confirm}>{busy ? "Confirming…" : "Confirm selected changes"}</Button></div>
    </> : <>
      <h3>Choose which meeting to keep</h3>
      <div className={styles.keptCard}><CheckCircle aria-hidden className="size-4" /><div><strong>{keptEvent?.title || "Meeting"}</strong><p>{keptAccount?.google_email} · {keptEvent ? eventTime(keptEvent, board.time_zone) : "Time unavailable"}</p></div></div>
      <p>Keep this meeting or choose another below. Select one or two invitations to decline. Meetings you organised or can only view stay unchanged.</p>
      <div className={styles.choiceList}>{choices.map(choice => {
        const checked = selected.includes(key(choice.ref));
        return <div key={key(choice.ref)} className={styles.choice}>
          <label><input type="checkbox" disabled={busy || !choice.canDecline || (!checked && selected.length >= 2)} checked={checked} onChange={event => { resetReview(); const next = event.target.checked ? [...selected, key(choice.ref)] : selected.filter(value => value !== key(choice.ref)); setSelected(next); onDraftChange({ selected: next, notes }); }} /><span><strong>{choice.event.title}</strong><small>{choice.email} · {eventTime(choice.event, board.time_zone)}</small>{!choice.canDecline ? <small>{choice.event.organizer?.self ? "You organised this meeting, so there is no invitation to decline. Move or cancel it in Google Calendar." : "This invitation cannot be declined from here. Change it in Google Calendar."}</small> : null}</span></label>
          <CalendarCompactAction disabled={busy} onClick={() => onChooseKeep(choice.ref)}>Keep this instead</CalendarCompactAction>
          {checked ? <label className={styles.noteLabel}>Note to this organizer<Textarea disabled={busy} value={notes[key(choice.ref)] || ""} maxLength={MAX_CALENDAR_DECLINE_REASON_LENGTH} onChange={event => { resetReview(); const next = { ...notes, [key(choice.ref)]: event.target.value }; setNotes(next); onDraftChange({ selected, notes: next }); }} placeholder="Explain why you cannot attend" /></label> : null}
        </div>;
      })}</div>
      <CalendarCompactAction disabled={busy || !board.complete || !board.conflicts_complete || selected.length === 0 || selected.some(value => !notes[value]?.trim() || notes[value].length > MAX_CALENDAR_DECLINE_REASON_LENGTH)} onClick={prepare}>{busy ? "Preparing…" : "Review Calendar and Mail"}</CalendarCompactAction>
    </>}
    {error ? <div role="alert" className={styles.conflictError}><AlertTriangle aria-hidden className="size-4" /><span>{error.message}{error instanceof GoogleCalendarError && error.reasonCode?.startsWith("GMAIL") && onMailConnect ? <CalendarCompactAction disabled={busy} onClick={() => void execute(onMailConnect)}>Enable Mail sending</CalendarCompactAction> : null}</span></div> : null}
  </section>;
}

function itemTime(item: { start: CalendarEventSummary["start"]; end: CalendarEventSummary["end"] }, zone: string) {
  return eventTime({ title: "", start: item.start, end: item.end }, zone);
}
