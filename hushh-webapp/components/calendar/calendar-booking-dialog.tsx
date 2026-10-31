"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { bookingDefaultDuration, bookingInstant, bookingLocalFields } from "@/lib/calendar/calendar-booking-time";
import { calendarTimeZone } from "@/lib/calendar/calendar-time-zone";
import { verifiedCalendarAccountPhoto, type CalendarHusshPeople } from "@/lib/calendar/calendar-hussh-people";
import { GoogleCalendarService, type CalendarBoardBookingReview, type CalendarExecution, type GoogleCalendarAccount, type CalendarOpening } from "@/lib/services/google-calendar-service";
import styles from "./calendar-booking-dialog.module.css";
import { CalendarPersonAvatar } from "./calendar-person-avatar";

export type BookingOpening = CalendarOpening & { accountId: string | null; scope: "account" | "all"; titleHint?: string; timeZoneHint?: string; followupRequest?: { id: string; revision: number } };
type Draft = {
  accountId: string; title: string; date: string; time: string; duration: 15 | 30 | 60;
  timeZone: string; guests: string[]; description: string;
  meetingType: "google_meet" | "external_link" | "in_person"; meetingLink: string; location: string;
};

function initialDraft(opening: BookingOpening, timeZone: string): Draft {
  const local = bookingLocalFields(opening.start_at, timeZone);
  return {
    accountId: opening.accountId || "", title: opening.titleHint || "", date: local.date, time: local.time,
    duration: bookingDefaultDuration(opening), timeZone: calendarTimeZone(timeZone), guests: [], description: "",
    meetingType: "google_meet", meetingLink: "", location: "",
  };
}

function emailAddress(value: string) {
  const email = value.trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) && email.length <= 320 ? email : null;
}

export function CalendarBookingDialog({ opening, accounts, people, userId, token, timeZone, alternatives, onClose, onConfirmed, onConflict, onRequireWrite }: {
  opening: BookingOpening;
  accounts: GoogleCalendarAccount[];
  people: CalendarHusshPeople;
  userId: string;
  token: string | null;
  timeZone: string;
  alternatives: CalendarOpening[];
  onClose: () => void;
  onConfirmed: (result: CalendarExecution, startAt: string, accountId: string, accountEmail: string) => void;
  onConflict: () => void;
  onRequireWrite: (accountId: string) => void;
}) {
  const [draft, setDraft] = useState(() => initialDraft(opening, timeZone));
  const [review, setReview] = useState<CalendarBoardBookingReview | null>(null);
  const reviewedContext = useRef<{ accountKey: string; token: string; userId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guestInput, setGuestInput] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const contactsId = useId();
  const account = accounts.find(item => item.account_id === draft.accountId);
  const accountEmail = account?.google_email || "Google account";
  const accountPhoto = verifiedCalendarAccountPhoto(account, accountEmail, people);
  const reviewedAccount = review ? accounts.find(item => item.account_id === review.plan.account_id) : null;
  const reviewEmail = review?.plan.board_accounts.find(item => item.account_id === review.plan.account_id)?.account_email || reviewedAccount?.google_email || accountEmail;
  const reviewPhoto = verifiedCalendarAccountPhoto(reviewedAccount ?? undefined, reviewEmail, people);
  const accountKey = accounts.map(item => `${item.account_id}:${item.google_email}:${item.connected}:${item.access_level}:${item.grant_generation}`).join("|");
  const accountKeyRef = useRef(accountKey);
  accountKeyRef.current = accountKey;
  useEffect(() => { setReview(null); reviewedContext.current = null; }, [accountKey, token, userId]);
  const edit = (change: Partial<Draft>) => { setDraft(current => ({ ...current, ...change })); setReview(null); reviewedContext.current = null; setError(null); };
  const close = () => { if (!busyRef.current) onClose(); };
  useBackLayer(ROUTES.CALENDAR, 2, () => { close(); return true; });

  const addGuest = () => {
    const email = emailAddress(guestInput);
    if (!email) { setError("Enter a valid guest email address."); return; }
    if (!draft.guests.includes(email)) edit({ guests: [...draft.guests, email] });
    setGuestInput("");
  };
  const contacts = [...people].filter(([, person]) => person.userId !== userId);
  const checkedAlternatives = alternatives.filter(window => {
    if (Date.parse(window.start_at) <= Date.now()) return false;
    try { return bookingLocalFields(window.start_at, draft.timeZone).date === draft.date; }
    catch { return false; }
  });
  const hasGuests = Boolean(review ? review.plan.attendees.length : draft.guests.length);
  const confirmLabel = hasGuests ? "Schedule meeting" : "Schedule personal block";
  const displayTime = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: draft.timeZone });

  const prepare = async () => {
    if (busyRef.current) return;
    if (!token) { setError("Unlock One before scheduling a Calendar event."); return; }
    if (!account?.connected || !account.google_email) { setError("Reconnect the selected Calendar account."); return; }
    if (account.access_level !== "manage") { setError("Allow scheduling on this Calendar account first. Nothing has been created."); return; }
    if (!draft.title.trim()) { setError("Enter a meeting title."); return; }
    if (draft.meetingType === "external_link" && !draft.meetingLink.trim()) { setError("Enter your existing meeting link."); return; }
    if (draft.meetingType === "in_person" && !draft.location.trim()) { setError("Enter the in-person location."); return; }
    const pendingGuest = guestInput.trim() ? emailAddress(guestInput) : null;
    if (guestInput.trim() && !pendingGuest) { setError("Enter a valid guest email address."); return; }
    const guests = pendingGuest ? [...new Set([...draft.guests, pendingGuest])] : draft.guests;
    if (pendingGuest) { setDraft(current => ({ ...current, guests })); setGuestInput(""); }
    let startAt: string;
    const nextZone = calendarTimeZone(draft.timeZone);
    try { startAt = bookingInstant(draft.date, draft.time, nextZone); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Choose a valid time."); return; }
    if (Date.parse(startAt) <= Date.now()) { setError("Choose a future time."); return; }
    const endAt = new Date(Date.parse(startAt) + draft.duration * 60_000).toISOString();
    busyRef.current = true; setBusy(true); setError(null);
    const owner = snapshotValidatedAuthSessionOwner();
    const requestAccountKey = accountKeyRef.current;
    try {
      const proposed = await GoogleCalendarService.reviewBoardBooking({
        vaultOwnerToken: token, userId, accountId: draft.accountId,
        checkedAccountIds: accounts.map(item => item.account_id), selectedDate: draft.date,
        title: draft.title.trim(), startAt, endAt, timeZone: nextZone,
        attendees: guests, description: draft.description.trim(), meetingType: draft.meetingType,
        meetingLink: draft.meetingType === "external_link" ? draft.meetingLink.trim() : "",
        location: draft.meetingType === "in_person" ? draft.location.trim() : "",
      });
      if ((!owner || isValidatedAuthSessionOwnerCurrent(owner)) && requestAccountKey === accountKeyRef.current) {
        setReview(proposed);
        reviewedContext.current = { accountKey: requestAccountKey, token, userId };
        if (proposed.plan.board_conflicts.length) { setError("This time overlaps a checked Calendar account. Choose another opening."); onConflict(); }
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Calendar review could not be prepared.");
      onConflict();
    } finally { busyRef.current = false; setBusy(false); }
  };

  const confirm = async () => {
    if (busyRef.current || !review || review.plan.board_conflicts.length || !token) return;
    if (reviewedContext.current?.accountKey !== accountKey || reviewedContext.current?.token !== token || reviewedContext.current?.userId !== userId) {
      setReview(null); setError("Calendar account or owner changed. Review the time again."); return;
    }
    if (Date.parse(review.expires_at) <= Date.now()) { setReview(null); setError("The review expired. Review the time again."); return; }
    busyRef.current = true; setBusy(true); setError(null);
    const owner = snapshotValidatedAuthSessionOwner();
    const proposed = review;
    // One confirmed proposal is one attempt. Even an uncertain provider result
    // cannot be replayed or silently replaced with a fresh proposal.
    setReview(null); reviewedContext.current = null;
    try {
      const result = await GoogleCalendarService.executeProposal({
        vaultOwnerToken: token, userId, proposalId: proposed.proposal_id, accountId: proposed.plan.account_id,
      });
      if (!result.event?.id) throw new Error("Calendar did not confirm the event. Check Google Calendar before booking again.");
      if (!owner || isValidatedAuthSessionOwnerCurrent(owner)) {
        const reviewedAccount = proposed.plan.board_accounts.find(item => item.account_id === proposed.plan.account_id);
        onConfirmed(result, result.event.start?.dateTime || proposed.plan.start_at, proposed.plan.account_id, reviewedAccount?.account_email || "the selected account");
      }
    } catch (failure) {
      setError(failure instanceof Error ? `${failure.message} Check Calendar before booking again if the result is uncertain.` : "Check Google Calendar before booking again.");
      onConflict();
    } finally { busyRef.current = false; setBusy(false); }
  };

  const chooseAlternative = (window: CalendarOpening) => {
    const local = bookingLocalFields(window.start_at, draft.timeZone);
    edit({ date: local.date, time: local.time, duration: bookingDefaultDuration(window) });
  };

  return <Dialog modal open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className={styles.dialog} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader className={styles.header}><DialogTitle>Schedule meeting</DialogTitle><DialogDescription>Nothing is scheduled yet.</DialogDescription></DialogHeader>
      {!review ? <div className={styles.fields}>
        <label>Title<Input autoFocus required maxLength={512} value={draft.title} onChange={event => edit({ title: event.target.value })} placeholder="Project planning meeting" disabled={busy} /></label>
        {opening.scope === "all" ? <label>Calendar account and destination<select value={draft.accountId} onChange={event => edit({ accountId: event.target.value })} disabled={busy}>
          <option value="">Choose a writable account</option>
          {accounts.map(item => <option key={item.account_id} value={item.account_id}>{item.google_email || "Google account"} · Primary calendar{item.access_level === "manage" ? "" : " · Allow scheduling"}</option>)}
        </select></label> : null}
        {account ? <p className={styles.accountIdentity}><CalendarPersonAvatar name={accountEmail} photoUrl={accountPhoto} source="hussh" /><span>{accountEmail} · Primary calendar</span></p> : null}
        {account && account.access_level !== "manage" ? <Button variant="outline" disabled={busy} onClick={() => onRequireWrite(account.account_id)}>Allow scheduling on {account.google_email}</Button> : null}
        <div className={styles.timeGrid}><label>Date<Input type="date" value={draft.date} onChange={event => edit({ date: event.target.value })} disabled={busy} /></label><label>Start<Input type="time" value={draft.time} onChange={event => edit({ time: event.target.value })} disabled={busy} /></label><label>Duration<select value={draft.duration} onChange={event => edit({ duration: Number(event.target.value) as Draft["duration"] })} disabled={busy}><option value={15}>15 min</option><option value={30}>30 min</option><option value={60}>60 min</option></select></label></div>
        <label>Guests (optional)<div className={styles.guestEntry}><Input type="email" list={contactsId} value={guestInput} onChange={event => { setGuestInput(event.target.value); setReview(null); reviewedContext.current = null; }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); addGuest(); } }} placeholder="name@example.com" disabled={busy} /><Button type="button" variant="outline" onClick={addGuest} disabled={busy}>Add</Button></div></label>
        <datalist id={contactsId}>{contacts.map(([email, person]) => <option key={email} value={email} label={person.displayName || email} />)}</datalist>
        {draft.guests.length ? <ul className={styles.guests}>{draft.guests.map(email => <li key={email}>{email}<button type="button" aria-label={`Remove ${email}`} disabled={busy} onClick={() => edit({ guests: draft.guests.filter(value => value !== email) })}>×</button></li>)}</ul> : <p className={styles.hint}>No guests creates a personal calendar block with no invitations.</p>}
        <label>Where<select value={draft.meetingType} onChange={event => edit({ meetingType: event.target.value as Draft["meetingType"] })} disabled={busy}><option value="google_meet">Google Meet</option><option value="external_link">Existing Meet, Zoom, or Teams link</option><option value="in_person">In person</option></select></label>
        {draft.meetingType === "external_link" ? <label>Meeting link<Input type="url" value={draft.meetingLink} onChange={event => edit({ meetingLink: event.target.value })} placeholder="https://zoom.us/j/123456789" disabled={busy} /></label> : null}
        {draft.meetingType === "in_person" ? <label>Location<Input value={draft.location} onChange={event => edit({ location: event.target.value })} placeholder="Where to meet" disabled={busy} /></label> : null}
        <details className={styles.description}><summary>Description (optional)</summary><Textarea maxLength={8000} value={draft.description} onChange={event => edit({ description: event.target.value })} disabled={busy} /></details>
      </div> : null}
      {review ? <section className={styles.review} aria-label="Meeting review">
        <h3>Review details</h3>
        <p><strong>{review.plan.title}</strong> · {displayTime(review.plan.start_at)} – {new Date(review.plan.end_at).toLocaleTimeString(undefined, { timeZone: review.plan.time_zone, timeStyle: "short" })}</p>
        <p className={styles.accountIdentity}><CalendarPersonAvatar name={reviewEmail} photoUrl={reviewPhoto} source="hussh" /><span>{reviewEmail} · Primary calendar</span></p>
        <p>{review.plan.attendees.length ? `Invitations: ${review.plan.attendees.join(", ")}` : "Personal block · No invitations"}</p>
        <p>{review.plan.meeting_type === "google_meet" ? "Google Meet link requested" : review.plan.meeting_type === "external_link" ? review.plan.meeting_link : review.plan.location}</p>
        {review.plan.description ? <p>{review.plan.description}</p> : null}
        {review.plan.board_conflicts.length ? <ul>{review.plan.board_conflicts.map((item, index) => <li key={`${item.account_id}:${index}`}>Busy on {item.account_email}: {displayTime(item.start_at)}</li>)}</ul> : null}
      </section> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {error && checkedAlternatives.length ? <div className={styles.alternatives}><p>Other checked openings on {draft.date}</p>{checkedAlternatives.slice(0, 3).map(window => <Button key={`${window.start_at}:${window.end_at}`} variant="outline" onClick={() => chooseAlternative(window)} disabled={busy}>{displayTime(window.start_at)}</Button>)}</div> : null}
      <div className={styles.actions}><Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>{review ? <Button variant="outline" onClick={() => { setReview(null); reviewedContext.current = null; setError(null); }} disabled={busy}>Edit details</Button> : null}{review && !review.plan.board_conflicts.length ? <Button onClick={() => void confirm()} disabled={busy}>{confirmLabel}</Button> : !review ? <Button onClick={() => void prepare()} disabled={busy || !draft.accountId}>Review meeting</Button> : null}</div>
    </DialogContent>
  </Dialog>;
}
