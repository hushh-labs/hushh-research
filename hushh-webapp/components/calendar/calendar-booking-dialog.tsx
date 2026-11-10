"use client";

import presentationStyles from "./calendar-presentation.module.css";
import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { CaretDownIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { bookingDefaultDuration, bookingInstant, bookingLocalFields } from "@/lib/calendar/calendar-booking-time";
import { GoogleCalendarError } from "@/lib/services/google-calendar-transport";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { calendarTimeZone } from "@/lib/calendar/calendar-time-zone";
import { verifiedCalendarAccountPhoto, type CalendarHusshPeople } from "@/lib/calendar/calendar-hussh-people";
import { GoogleCalendarService, type CalendarExecution, type GoogleCalendarAccount, type CalendarOpening } from "@/lib/services/google-calendar-service";
import styles from "./calendar-booking-dialog.module.css";
import { CalendarPersonAvatar } from "./calendar-person-avatar";

export type BookingOpening = CalendarOpening & { accountId: string | null; scope: "account" | "all"; titleHint?: string; timeZoneHint?: string; followupRequest?: { id: string; revision: number } };
type Draft = {
  accountId: string; title: string; date: string; time: string; duration: 15 | 30 | 60;
  timeZone: string; guests: string[]; description: string;
  meetingType: "google_meet" | "external_link" | "in_person"; meetingLink: string; location: string;
};

function BookingSelect(props: ComponentProps<"select">) {
  return <span className={styles.selectField}><select {...props} /><CaretDownIcon aria-hidden className={styles.selectChevron} /></span>;
}

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

export function CalendarBookingDialog({ opening, accounts, people, accountPeople, userId, token, timeZone, alternatives, onClose, onConfirmed, onConflict, onRequireWrite }: {
  opening: BookingOpening;
  accounts: GoogleCalendarAccount[];
  people: CalendarHusshPeople;
  accountPeople: CalendarHusshPeople;
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
  const [conflicts, setConflicts] = useState<{ account_id: string; account_email: string; start_at: string }[]>([]);
  const [uncertain, setUncertain] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [guestInput, setGuestInput] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const contactsId = useId();
  const account = accounts.find(item => item.account_id === draft.accountId);
  const accountEmail = account?.google_email || "Google account";
  const accountPhoto = verifiedCalendarAccountPhoto(account, accountEmail, accountPeople);
  const accountKey = accounts.map(item => `${item.account_id}:${item.google_email}:${item.connected}:${item.access_level}:${item.grant_generation}`).join("|");
  const liveContext = useRef({ accountKey, token, userId });
  liveContext.current = { accountKey, token, userId };
  const edit = (change: Partial<Draft>) => {
    setDraft(current => ({ ...current, ...change }));
    setConflicts([]);
    if (!uncertain) setError(null);
  };
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
  const displayTime = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: draft.timeZone });

  const schedule = async () => {
    if (busyRef.current || uncertain) return;
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
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setConflicts([]);
    const owner = snapshotValidatedAuthSessionOwner();
    const vaultEpoch = snapshotVaultSessionEpoch();
    const current = () => mounted.current && isVaultSessionEpochCurrent(vaultEpoch) &&
      (!owner || isValidatedAuthSessionOwnerCurrent(owner)) &&
      liveContext.current.accountKey === accountKey && liveContext.current.token === token && liveContext.current.userId === userId;
    const flagUncertain = () => {
      if (!mounted.current) return;
      setUncertain(true);
      setError("Check Google Calendar before booking again. The event may have been created.");
    };
    let executing = false;
    try {
      const proposed = await GoogleCalendarService.reviewBoardBooking({
        vaultOwnerToken: token, userId, accountId: draft.accountId,
        checkedAccountIds: accounts.map(item => item.account_id), selectedDate: draft.date,
        title: draft.title.trim(), startAt, endAt, timeZone: nextZone,
        attendees: guests, description: draft.description.trim(), meetingType: draft.meetingType,
        meetingLink: draft.meetingType === "external_link" ? draft.meetingLink.trim() : "",
        location: draft.meetingType === "in_person" ? draft.location.trim() : "",
      });
      if (!current()) return;
      if (proposed.plan.account_id !== draft.accountId ||
          Date.parse(proposed.plan.start_at) !== Date.parse(startAt) ||
          Date.parse(proposed.plan.end_at) !== Date.parse(endAt) ||
          !(Date.parse(proposed.expires_at) > Date.now())) {
        setError("Calendar details changed. Schedule again.");
        return;
      }
      if (proposed.plan.board_conflicts.length) {
        setConflicts(proposed.plan.board_conflicts);
        setError("This time overlaps a checked calendar. Choose another time.");
        onConflict();
        return;
      }
      executing = true;
      const result = await GoogleCalendarService.executeProposal({
        vaultOwnerToken: token, userId, proposalId: proposed.proposal_id, accountId: draft.accountId, isEffectCurrent: current,
      });
      if (!current()) { flagUncertain(); return; }
      if (result.action !== "create" || !result.event?.id) throw new Error("Calendar did not confirm the event.");
      onConfirmed(result, result.event.start?.dateTime || startAt, draft.accountId, account.google_email);
    } catch (failure) {
      if (!current()) {
        if (executing) flagUncertain();
        return;
      }
      const blockedBeforeWrite = failure instanceof GoogleCalendarError && [
        "calendar_availability_changed", "calendar_accounts_changed", "calendar_selection_changed",
        "calendar_destination_read_only", "calendar_permission_required",
      ].includes(failure.reasonCode || "");
      if (executing && !blockedBeforeWrite) {
        flagUncertain();
      } else {
        setError(failure instanceof Error ? failure.message : "Couldn’t schedule the meeting. Try again.");
      }
      onConflict();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const chooseAlternative = (window: CalendarOpening) => {
    const local = bookingLocalFields(window.start_at, draft.timeZone);
    edit({ date: local.date, time: local.time, duration: bookingDefaultDuration(window) });
  };

  return <Dialog modal open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className={`${styles.dialog} ${presentationStyles.portal}`} data-connect-type-scale="page" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader className={styles.header}><DialogTitle>Schedule meeting</DialogTitle><DialogDescription>Nothing is scheduled yet.</DialogDescription></DialogHeader>
      <div className={styles.body} data-calendar-booking-body aria-busy={busy}>
      <div className={styles.fields}>
        <label>Title<Input autoFocus required maxLength={512} value={draft.title} onChange={event => edit({ title: event.target.value })} placeholder="Project planning meeting" disabled={busy} /></label>
        {opening.scope === "all" ? <label>Calendar account and destination<BookingSelect value={draft.accountId} onChange={event => edit({ accountId: event.target.value })} disabled={busy}>
          <option value="">Choose a writable account</option>
          {accounts.map(item => <option key={item.account_id} value={item.account_id}>{item.google_email || "Google account"}{item.access_level === "manage" ? "" : " · Allow scheduling"}</option>)}
        </BookingSelect></label> : null}
        {account ? <p className={styles.accountIdentity}><CalendarPersonAvatar name={accountEmail} photoUrl={accountPhoto} source="hussh" /><span>{accountEmail}</span></p> : null}
        {account && account.access_level !== "manage" ? <Button variant="outline" disabled={busy} onClick={() => onRequireWrite(account.account_id)}>Allow scheduling</Button> : null}
        <div className={styles.timeGrid}><label>Date<Input type="date" value={draft.date} onChange={event => edit({ date: event.target.value })} disabled={busy} /></label><label>Start<Input type="time" value={draft.time} onChange={event => edit({ time: event.target.value })} disabled={busy} /></label><label>Duration<BookingSelect value={draft.duration} onChange={event => edit({ duration: Number(event.target.value) as Draft["duration"] })} disabled={busy}><option value={15}>15 min</option><option value={30}>30 min</option><option value={60}>60 min</option></BookingSelect></label></div>
        <div className={styles.guestField}>
          <label htmlFor={`${contactsId}-guest`}>Guests</label>
          <div className={styles.guestEntry}><Input id={`${contactsId}-guest`} type="email" list={contactsId} value={guestInput} onChange={event => setGuestInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); addGuest(); } }} placeholder="name@example.com" disabled={busy} /><Button type="button" variant="outline" onClick={addGuest} disabled={busy}>Add</Button></div>
        </div>
        <datalist id={contactsId}>{contacts.map(([email, person]) => <option key={email} value={email} label={person.displayName || email} />)}</datalist>
        {draft.guests.length ? <ul className={styles.guests}>{draft.guests.map(email => <li key={email}><span>{email}</span><button type="button" aria-label={`Remove ${email}`} disabled={busy} onClick={() => edit({ guests: draft.guests.filter(value => value !== email) })}>×</button></li>)}</ul> : null}
        {draft.guests.length > 0 || emailAddress(guestInput) ? <p className={presentationStyles.support}>Guests will receive an invitation.</p> : null}
        <label>Where<BookingSelect value={draft.meetingType} onChange={event => edit({ meetingType: event.target.value as Draft["meetingType"] })} disabled={busy}><option value="google_meet">Google Meet</option><option value="external_link">Existing Meet, Zoom, or Teams link</option><option value="in_person">In person</option></BookingSelect></label>
        {draft.meetingType === "external_link" ? <label>Meeting link<Input type="url" value={draft.meetingLink} onChange={event => edit({ meetingLink: event.target.value })} placeholder="https://zoom.us/j/123456789" disabled={busy} /></label> : null}
        {draft.meetingType === "in_person" ? <label>Location<Input value={draft.location} onChange={event => edit({ location: event.target.value })} placeholder="Where to meet" disabled={busy} /></label> : null}
        <details className={styles.description}><summary>Description (optional)</summary><Textarea maxLength={8000} value={draft.description} onChange={event => edit({ description: event.target.value })} disabled={busy} /></details>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {conflicts.length ? <ul className={styles.conflicts}>{conflicts.map((item, index) => <li key={`${item.account_id}:${index}`}>Busy on {item.account_email} · {displayTime(item.start_at)}</li>)}</ul> : null}
      {error && !uncertain && checkedAlternatives.length ? <div className={styles.alternatives}><p>Other checked openings on {draft.date}</p>{checkedAlternatives.slice(0, 3).map(window => <Button key={`${window.start_at}:${window.end_at}`} variant="outline" onClick={() => chooseAlternative(window)} disabled={busy}>{displayTime(window.start_at)}</Button>)}</div> : null}
      </div>
      <div className={styles.actions} data-calendar-booking-actions>
        <Button variant="outline" onClick={close} disabled={busy}>{uncertain ? "Close" : "Cancel"}</Button>
        <Button onClick={() => void schedule()} disabled={busy || uncertain || !draft.accountId}>{busy ? "Scheduling…" : "Schedule meeting"}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
