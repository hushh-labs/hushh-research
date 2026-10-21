"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle, Clock, MoreHorizontal, Plus, RefreshCw } from "@/components/icons";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { notifyCalendarChanged, calendarRefreshKey } from "@/lib/calendar/calendar-refresh";
import { CacheService } from "@/lib/services/cache-service";
import { ROUTES } from "@/lib/navigation/routes";
import { safeMeetingUrl } from "@/lib/calendar/calendar-url";
import type { CalendarSlotHandoff } from "@/lib/calendar/calendar-slot-handoff";
import { GoogleCalendarService, type CalendarBoardAccount, type CalendarBoardConflict, type CalendarBoardDay, type CalendarEventSummary, type CalendarInvitation, type GoogleCalendarStatus } from "@/lib/services/google-calendar-service";
import { CalendarDateNavigation } from "./calendar-date-navigation";
import { CalendarInvitationActions } from "./calendar-invitation-actions";
import { CalendarConflictPanel } from "./calendar-conflict-panel";
import { CalendarInvitations } from "./calendar-invitations";
import { CalendarInsights } from "./calendar-insights";
import { calendarDate, eventTime, availabilityTimeRangeLabel } from "./calendar-schedule-presentation";
import styles from "./calendar-account-board.module.css";

type Props = {
  userId: string;
  status: GoogleCalendarStatus;
  busy: boolean;
  connectionRevision?: number;
  connectionNotice?: React.ReactNode;
  token: string | null;
  getIdToken: () => Promise<string>;
  onAddAccount: () => void;
  onReconnectAccount: (accountId: string) => void;
  onDisconnectAccount: (accountId: string) => void;
  onConnect: (access: "read" | "manage", includeCalendarList?: boolean) => void;
  onMailConnect?: () => Promise<void>;
  onChat: (prompt?: string, slot?: CalendarSlotHandoff) => void;
};

type Selection = { accountId: string; calendarId: string; eventId: string };
type EventRef = { account_id: string; calendar_id: string; event_id: string };
const identity = (item: Selection | EventRef) => "account_id" in item
  ? `${item.account_id}\u001f${item.calendar_id}\u001f${item.event_id}`
  : `${item.accountId}\u001f${item.calendarId}\u001f${item.eventId}`;
const eventIdentity = (event: CalendarEventSummary) => identity({
  accountId: event.account_id || "default", calendarId: event.calendar_id || "primary", eventId: event.id || "",
});

function responseStatus(event: CalendarEventSummary, email: string): CalendarInvitation["response_status"] {
  const own = event.attendees?.find(attendee => attendee.email?.toLowerCase() === email.toLowerCase());
  const response = own?.response_status;
  return response === "accepted" || response === "declined" || response === "tentative" ? response : "needsAction";
}

function toInvitation(event: CalendarEventSummary, account: CalendarBoardAccount): CalendarInvitation {
  return {
    ...event,
    id: event.id || "",
    calendar_id: event.calendar_id || "primary",
    response_status: responseStatus(event, account.google_email),
    can_respond: event.can_decline === true,
    conflicts: [],
  };
}

function pairIncludes(pair: CalendarBoardConflict, selection: Selection) {
  return identity(pair.left) === identity(selection) || identity(pair.right) === identity(selection);
}

function otherSide(pair: CalendarBoardConflict, selection: Selection) {
  return identity(pair.left) === identity(selection) ? pair.right : pair.left;
}

function accountLabel(email: string | null) { return email || "Google account"; }

export function CalendarAccountBoard({ userId, status, busy, connectionRevision, connectionNotice, token, getIdToken, onAddAccount, onReconnectAccount, onDisconnectAccount, onConnect, onMailConnect, onChat }: Props) {
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [zone, setZone] = useState(deviceZone);
  const [zoneInput, setZoneInput] = useState(deviceZone);
  const [zoneError, setZoneError] = useState("");
  const today = calendarDate(Date.now(), zone);
  const [date, setDate] = useState(today);
  const [duration, setDuration] = useState<15 | 30 | 60>(30);
  const [tab, setTab] = useState<"board" | "invitations" | "insights">("board");
  const [invitationAccount, setInvitationAccount] = useState(status.accounts?.[0]?.account_id || "default");
  const [views, setViews] = useState<Record<string, "events" | "free">>({});
  const [calendarOverridesByAccount, setCalendarOverridesByAccount] = useState<Record<string, Record<string, boolean>>>({});
  const [pendingExclusion, setPendingExclusion] = useState<{ accountId: string; calendarId: string; name: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const epoch = snapshotVaultSessionEpoch();
  const accountGeneration = (status.accounts || []).map(account => `${account.account_id}:${account.status}:${account.google_email}:${account.access_level}:${account.calendar_list_access}`).join("|");
  const overridesKey = JSON.stringify(calendarOverridesByAccount);
  const key = `${userId}:${date}:${zone}:${duration}:${epoch}:${connectionRevision || 0}:${accountGeneration}:${overridesKey}`;
  const requestKey = `${key}:${revision}`;
  const currentKey = useRef(requestKey); currentKey.current = requestKey;
  const request = useRef(0);
  const tokenGetter = useRef(getIdToken); tokenGetter.current = getIdToken;
  const [snapshot, setSnapshot] = useState<{ key: string; value: CalendarBoardDay | null; error: string | null }>({ key: "", value: null, error: null });
  const board = snapshot.key === key ? snapshot.value : null;
  const error = snapshot.key === key ? snapshot.error : null;
  const loading = snapshot.key !== key;
  const [selected, setSelected] = useState<Selection | null>(null);
  const [resolving, setResolving] = useState(false);
  const [conflictDraft, setConflictDraft] = useState<{ selected: string[]; notes: Record<string, string> }>({ selected: [], notes: {} });
  const selectedRef = useRef<Selection | null>(null); selectedRef.current = selected;
  const refreshOnClose = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const number = ++request.current;
    const isCurrent = () => !controller.signal.aborted && currentKey.current === requestKey && number === request.current && isVaultSessionEpochCurrent(epoch);
    void (async () => {
      try {
        const firebaseIdToken = await tokenGetter.current();
        if (!isCurrent()) return;
        const value = await GoogleCalendarService.boardDay({ firebaseIdToken, date, timeZone: zone, durationMinutes: duration, calendarOverridesByAccount, signal: controller.signal, isEffectCurrent: isCurrent });
        if (isCurrent()) setSnapshot({ key, value, error: null });
      } catch (failure) {
        if (isCurrent()) setSnapshot(previous => ({ key, value: previous.key === key ? previous.value : null, error: failure instanceof Error ? failure.message : "Calendar could not be checked." }));
      }
    })();
    return () => { controller.abort(); request.current += 1; };
  }, [requestKey, key, date, zone, duration, epoch, calendarOverridesByAccount]);
  usePeriodicTask(`calendar-board:${userId}`, 60_000, () => {
    if (tab === "board" && !selectedRef.current && !actionBusy && !busy) setRevision(value => value + 1);
  }, { enabled: tab === "board" });
  useEffect(() => CacheService.getInstance().subscribe(event => {
    if (event.type === "set" && event.key === calendarRefreshKey(userId)) {
      if (selectedRef.current) refreshOnClose.current = true;
      else setRevision(value => value + 1);
    }
  }), [userId]);

  const accounts = board?.accounts || [];
  const selectedAccount = selected ? accounts.find(account => account.account_id === selected.accountId) : null;
  const selectedEvent = selectedAccount?.events.find(event => eventIdentity(event) === identity(selected!));
  const overlaps = selected && board ? board.conflicts.filter(pair => pairIncludes(pair, selected)) : [];
  const findEvent = (item: Selection) => accounts.find(account => account.account_id === item.accountId)?.events.find(event => eventIdentity(event) === identity(item));
  const open = (event: CalendarEventSummary, button: HTMLButtonElement) => {
    trigger.current = button;
    setResolving(false);
    setConflictDraft({ selected: [], notes: {} });
    setSelected({ accountId: event.account_id || "default", calendarId: event.calendar_id || "primary", eventId: event.id || "" });
  };
  const close = () => { if (!actionBusy) { setSelected(null); setResolving(false); setConflictDraft({ selected: [], notes: {} }); if (refreshOnClose.current) { refreshOnClose.current = false; setRevision(value => value + 1); } } };
  const checkedAt = board?.checked_at ? new Date(board.checked_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : null;
  const defaultConnected = status.accounts?.some(account => account.account_id === "default" && account.connected);
  // One's scheduling proposal currently rechecks only the default grant.
  // A multi-account opening is a comparison snapshot, not booking authority.
  const sharedHandoffAvailable = defaultConnected && accounts.length === 1;
  const selectSharedWindow = (window: { start_at: string; end_at: string }) => {
    if (!sharedHandoffAvailable) return;
    onChat(undefined, {
      ownerId: userId, accountEmail: status.accounts?.find(account => account.account_id === "default")?.google_email || "",
      date, windowStart: window.start_at, windowEnd: window.end_at,
      durationMinutes: duration, timeZone: zone,
    });
  };

  return <AppPageShell width="expanded" headerContentSpacing="compact" className={styles.shell} nativeTest={{ routeId: ROUTES.CALENDAR, marker: "native-route-calendar", authState: "authenticated", dataState: loading ? "loading" : error ? "error" : board?.complete ? "loaded" : "unavailable-valid" }}>
    <div className={styles.content} data-calendar-account-board>
      <PageHeader title="Calendar" titleRole="agent" actionsInlineMobile
        description={<span className={styles.description}>{status.accounts?.length || accounts.length} of 3 Google accounts added · Times shown in {zone}</span>}
        actions={<div className={styles.headerActions}>
          <Button variant="outline" disabled={busy || actionBusy || (status.accounts?.length || 0) >= 3} onClick={onAddAccount}><Plus aria-hidden className="size-4" />Add account</Button>
          <Button variant="ghost" size="icon" aria-label="Refresh all Calendar accounts" disabled={busy || actionBusy} onClick={() => setRevision(value => value + 1)}><RefreshCw aria-hidden className="size-5" /></Button>
        </div>} />
      {connectionNotice}
      <div className={styles.topTabs}><SegmentedTabs ariaLabel="Calendar sections" value={tab} onValueChange={value => setTab(value as typeof tab)} options={[{ value: "board", label: "Board" }, { value: "invitations", label: "Invitations" }, { value: "insights", label: "Insights" }]} /></div>
      {tab === "board" ? <>
        <div className={styles.toolbar}>
          <CalendarDateNavigation date={date} today={today} disabled={busy || actionBusy} onChange={setDate} label="Calendar board date" />
          <SegmentedTabs ariaLabel="Free time duration" variant="filter" value={String(duration)} onValueChange={value => setDuration(Number(value) as 15 | 30 | 60)} options={[15, 30, 60].map(value => ({ value: String(value), label: `${value} min` }))} />
        </div>
        <form className={styles.zoneSetting} onSubmit={event => { event.preventDefault(); try { new Intl.DateTimeFormat("en", { timeZone: zoneInput }); const next = zoneInput.trim(); if (!next) throw new Error("Choose a time zone"); const wasToday = date === today; setZone(next); setZoneError(""); if (wasToday) setDate(calendarDate(Date.now(), next)); } catch { setZoneError("Use a valid IANA time zone, such as Asia/Kolkata."); } }}><label>Display time zone<Input value={zoneInput} onChange={event => setZoneInput(event.target.value)} aria-invalid={Boolean(zoneError)} /></label><Button variant="outline" type="submit">Apply</Button>{zoneError ? <p role="alert">{zoneError}</p> : null}</form>
        {loading ? <SurfaceCard className={styles.message} role="status">Checking all connected calendars…</SurfaceCard> : !board && error ? <SurfaceCard className={styles.message} role="alert"><p>{error}</p><Button variant="outline" onClick={() => setRevision(value => value + 1)}>Retry</Button></SurfaceCard> : board ? <>
          {error ? <SurfaceCard className={styles.message} role="alert"><p>Latest refresh failed: {error}. Times below were last checked {checkedAt || "earlier"}.</p><Button variant="outline" onClick={() => setRevision(value => value + 1)}>Retry</Button></SurfaceCard> : null}
          <div className={styles.summary} role="status">
            {board.conflicts_complete && !error ? <>{board.conflicts.length ? <AlertTriangle aria-hidden className="size-4" /> : <CheckCircle aria-hidden className={`${styles.clearIcon} size-4`} />}<strong>{board.conflicts.length} cross-account overlap{board.conflicts.length === 1 ? "" : "s"}</strong></> : <><AlertTriangle aria-hidden className="size-4" /><strong>Conflict check incomplete</strong></>}
            <span>{checkedAt ? `Checked ${checkedAt}` : "Checking"}</span>
          </div>
          <div className={styles.accounts} data-count={accounts.length}>
            {accounts.map((account, index) => {
              const view = views[account.account_id] || "events";
              const includedCalendars = (account.calendar_options || []).filter(calendar => calendarOverridesByAccount[account.account_id]?.[calendar.id] ?? calendar.availability_default_included !== false).length;
              return <SurfaceCard key={account.account_id} className={styles.account} data-account-index={index}>
                <div className={styles.accountHeader}>
                  <span className={styles.accountMark} aria-hidden><span /></span>
                  <div className={styles.accountIdentity}><h2>{accountLabel(account.google_email)}</h2><p>{account.status === "complete" ? "Connected" : account.status === "needs_reauth" ? "Reconnect needed" : "Check incomplete"}{account.checked_at ? ` · ${new Date(account.checked_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : ""}</p></div>
                  <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${accountLabel(account.google_email)}`}><MoreHorizontal aria-hidden className="size-5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => account.account_id === "default" ? onConnect("manage", true) : onReconnectAccount(account.account_id)}>Reconnect or update permission</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onDisconnectAccount(account.account_id)}>Disconnect this Calendar account</DropdownMenuItem>
                  </DropdownMenuContent></DropdownMenu>
                </div>
                <div className={styles.accountTabs}><SegmentedTabs ariaLabel={`View for ${accountLabel(account.google_email)}`} variant="filter" value={view} onValueChange={value => setViews(current => ({ ...current, [account.account_id]: value as "events" | "free" }))} options={[{ value: "events", label: `Events (${account.events.length})` }, { value: "free", label: `Free time (${account.free_windows.length})` }]} /></div>
                {account.calendar_options?.length ? <details className={styles.calendarSources}><summary>Calendars used for free time</summary><p>These choices change free time only. Events remain visible. Keep at least one calendar included.</p><div>{account.calendar_options.map(calendar => { const included = calendarOverridesByAccount[account.account_id]?.[calendar.id] ?? calendar.availability_default_included !== false; return <label key={calendar.id}><input type="checkbox" checked={included} disabled={included && includedCalendars <= 1} onChange={event => event.target.checked ? setCalendarOverridesByAccount(current => ({ ...current, [account.account_id]: { ...current[account.account_id], [calendar.id]: true } })) : setPendingExclusion({ accountId: account.account_id, calendarId: calendar.id, name: calendar.name || calendar.id })} /><span>{calendar.name || calendar.id}</span></label>; })}</div></details> : null}
                {account.status !== "complete" ? <div className={styles.accountError} role="status"><AlertTriangle aria-hidden className="size-4" /><p>{account.error || "This account could not be checked. Its time is excluded from shared availability."}</p><Button variant="outline" onClick={() => account.status === "needs_reauth" || account.reason_code?.includes("reauth") ? account.account_id === "default" ? onConnect("read", true) : onReconnectAccount(account.account_id) : setRevision(value => value + 1)}>{account.status === "needs_reauth" || account.reason_code?.includes("reauth") ? "Reconnect" : "Retry check"}</Button></div> : <div className={styles.accountStream} role="region" tabIndex={0} aria-label={`${view === "events" ? "Events" : "Free time"} for ${accountLabel(account.google_email)}`}>
                  {view === "events" ? <>
                    {account.unreadable_calendars.length ? <p className={styles.coverage}>Event details unavailable for {account.unreadable_calendars.map(calendar => calendar.name || calendar.id).join(", ")}. Busy time is still checked.</p> : null}
                    {account.events.length ? <ul className={styles.eventList}>{account.events.map(event => {
                      const choice: Selection = { accountId: account.account_id, calendarId: event.calendar_id || "primary", eventId: event.id || "" };
                      const count = board.conflicts.filter(pair => pairIncludes(pair, choice)).length;
                      return <li key={eventIdentity(event)} className={styles.eventCard}>
                        <button type="button" className={styles.eventMain} onClick={button => open(event, button.currentTarget)} aria-label={`Open ${event.title} in ${accountLabel(account.google_email)}`}>
                          <span className={styles.eventColor} style={{ backgroundColor: event.event_color || event.calendar_color || "var(--app-accent)" }} aria-hidden />
                          <span className={styles.eventCopy}><strong>{event.title}</strong><span>{eventTime(event, zone)}</span><small>{event.calendar_name || "Primary calendar"}{event.status === "cancelled" ? " · Cancelled" : ""}</small></span>
                        </button>
                        {count ? <button type="button" className={styles.conflictButton} aria-label={`Review ${count} overlapping meeting${count === 1 ? "" : "s"} for ${event.title} in ${accountLabel(account.google_email)}`} onClick={button => open(event, button.currentTarget)}><AlertTriangle aria-hidden className="size-4" /><span>{count}</span></button> : null}
                      </li>;
                    })}</ul> : <p className={styles.empty}>No readable events on this day.</p>}
                  </> : account.free_windows.length ? <ul className={styles.freeList}>{account.free_windows.map(window => <li key={`${window.start_at}:${window.end_at}`}><Clock aria-hidden className="size-4" /><span>{availabilityTimeRangeLabel(window.start_at, window.end_at, zone, date)}</span></li>)}</ul> : <p className={styles.empty}>No {duration}-minute openings on this day.</p>}
                </div>}
              </SurfaceCard>;
            })}
          </div>
          <SurfaceCard className={styles.shared}>
            <div className={styles.sharedTitle}><CheckCircle aria-hidden className="size-5" /><div><h2>Free across all accounts</h2><p>{board.complete && !error ? `${board.shared_free_windows.length} opening${board.shared_free_windows.length === 1 ? "" : "s"} of at least ${duration} minutes` : "Availability is incomplete until every account is checked."}</p></div></div>
            {board.complete && !error ? board.shared_free_windows.length ? <><ul className={styles.sharedList}>{board.shared_free_windows.map(window => <li key={`${window.start_at}:${window.end_at}`}>{sharedHandoffAvailable ? <button type="button" disabled={busy} onClick={() => selectSharedWindow(window)} aria-label={`Use shared free time ${availabilityTimeRangeLabel(window.start_at, window.end_at, zone, date)}`}>{availabilityTimeRangeLabel(window.start_at, window.end_at, zone, date)}<span>Use this time</span></button> : availabilityTimeRangeLabel(window.start_at, window.end_at, zone, date)}</li>)}</ul>{!sharedHandoffAvailable ? <p className={styles.readOnly}>These openings were checked across the connected accounts. Refresh before scheduling because availability can change.</p> : null}</> : <p>No shared opening on this day.</p> : <p role="alert">Reconnect or refresh the affected account before relying on shared free time.</p>}
          </SurfaceCard>
        </> : null}
      </> : tab === "invitations" ? <section className={styles.secondary} aria-label="Invitations">
        <label className={styles.accountPicker}>Calendar account<select value={invitationAccount} onChange={event => setInvitationAccount(event.target.value)}>{(status.accounts || []).map(account => <option key={account.account_id} value={account.account_id}>{accountLabel(account.google_email)}</option>)}</select></label>
        {status.accounts?.find(account => account.account_id === invitationAccount)?.connected ? <CalendarInvitations key={invitationAccount} userId={userId} accountId={invitationAccount} accountEmail={status.accounts.find(account => account.account_id === invitationAccount)?.google_email} zone={zone} getIdToken={getIdToken} busy={busy} connectionRevision={connectionRevision} onConnect={invitationAccount === "default" ? onConnect : () => onReconnectAccount(invitationAccount)} onMailConnect={onMailConnect} onResult={() => { notifyCalendarChanged(userId); setRevision(value => value + 1); }} /> : <p role="alert">Reconnect this account to see its invitations.</p>}
      </section> : <section className={styles.secondary} aria-label="Calendar insights">
        {board ? <SurfaceCard className={styles.insightSummary}><h2>Across your connected accounts today</h2><p>{board.accounts.reduce((sum, account) => sum + account.events.length, 0)} events · {board.conflicts.length} cross-account overlaps · {board.complete ? `${board.shared_free_windows.length} shared openings` : "shared availability incomplete"}</p></SurfaceCard> : null}
        {defaultConnected ? <CalendarInsights key={`${userId}:default:${epoch}:${zone}`} userId={userId} accountKey={`${status.google_email}:default:${connectionRevision || 0}`} date={today} zone={zone} getIdToken={getIdToken} vaultOwnerToken={token} /> : <p>Weekly insights for the default Google account are available when that account is connected.</p>}
      </section>}
      <div className={styles.footer}><Button onClick={() => onChat()} disabled={busy}>Try Calendar Agent with One</Button></div>
      <Dialog modal open={Boolean(selected && selectedEvent)} onOpenChange={isOpen => { if (!isOpen) close(); }}>
        <DialogContent className={styles.detail} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }} onEscapeKeyDown={event => { if (actionBusy) event.preventDefault(); }} onInteractOutside={event => { if (actionBusy) event.preventDefault(); }}>
          {selected && selectedEvent && selectedAccount ? <>
            <DialogHeader><DialogTitle>{resolving ? "Resolve overlapping meetings" : selectedEvent.title}</DialogTitle><DialogDescription>{accountLabel(selectedAccount.google_email)} · {eventTime(selectedEvent, zone)} · {zone}</DialogDescription></DialogHeader>
            {resolving && board ? <CalendarConflictPanel key={identity(selected)} board={board} keep={{ account_id: selected.accountId, calendar_id: selected.calendarId, event_id: selected.eventId }} token={token} getIdToken={getIdToken} initialDraft={conflictDraft} onDraftChange={setConflictDraft} onBusyChange={setActionBusy} onChooseKeep={ref => setSelected({ accountId: ref.account_id, calendarId: ref.calendar_id, eventId: ref.event_id })} onMailConnect={onMailConnect} onConfirmed={() => { refreshOnClose.current = true; }} onDone={close} /> : <>
            <p className={styles.detailSource}>{selectedEvent.calendar_name || "Primary calendar"}{selectedEvent.organizer?.email ? ` · Organized by ${selectedEvent.organizer.email}` : ""}</p>
            {selectedEvent.location ? <p className={styles.detailSource}>Location: {selectedEvent.location}</p> : null}
            {selectedEvent.description ? <p className={styles.detailDescription}>{selectedEvent.description}</p> : null}
            {safeMeetingUrl(selectedEvent.conference_url) ? <a className={styles.join} href={safeMeetingUrl(selectedEvent.conference_url)!} target="_blank" rel="noopener noreferrer">Join meeting</a> : null}
            {safeMeetingUrl(selectedEvent.html_link) ? <a className={styles.join} href={safeMeetingUrl(selectedEvent.html_link)!} target="_blank" rel="noopener noreferrer">Open in Google Calendar</a> : null}
            {overlaps.length ? <div className={styles.overlapDetail}><h3><AlertTriangle aria-hidden className="size-4" />Overlapping meetings</h3>{overlaps.map(pair => { const other = otherSide(pair, selected); const event = findEvent({ accountId: other.account_id, calendarId: other.calendar_id, eventId: other.event_id }); const account = accounts.find(item => item.account_id === other.account_id); return <div key={identity(other)} className={styles.overlapItem}><strong>{event?.title || "Another meeting"}</strong><p>{accountLabel(account?.google_email || null)} · {event ? eventTime(event, zone) : "Time unavailable"}</p><p>Overlap: {availabilityTimeRangeLabel(pair.start_at, pair.end_at, zone, date)}</p></div>; })}{!board?.conflicts_complete || error ? <p role="alert">Refresh every account before resolving conflicts.</p> : <Button variant="outline" disabled={actionBusy || busy} onClick={() => setResolving(true)}>Resolve these overlaps</Button>}</div> : null}
            {selectedEvent.can_decline ? <CalendarInvitationActions key={eventIdentity(selectedEvent)} event={toInvitation(selectedEvent, selectedAccount)} userId={userId} accountId={selectedAccount.account_id} token={token} zone={zone} getIdToken={getIdToken} expectedAccountEmail={selectedAccount.google_email} onBusyChange={setActionBusy} onConnect={selectedAccount.account_id === "default" ? onConnect : () => onReconnectAccount(selectedAccount.account_id)} onMailConnect={onMailConnect} onResult={() => { refreshOnClose.current = true; }} /> : <p className={styles.readOnly}>This event stays on its calendar. Attendance changes are available for invitations to this account.</p>}
            </>}
          </> : null}
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(pendingExclusion)} onOpenChange={isOpen => { if (!isOpen) setPendingExclusion(null); }}>
        <DialogContent><DialogHeader><DialogTitle>Exclude this calendar from free time?</DialogTitle><DialogDescription>{pendingExclusion?.name} will remain visible in Events. Free time may overlap its events.</DialogDescription></DialogHeader><div className={styles.conflictActions}><Button variant="outline" onClick={() => setPendingExclusion(null)}>Keep included</Button><Button onClick={() => { if (pendingExclusion) setCalendarOverridesByAccount(current => ({ ...current, [pendingExclusion.accountId]: { ...current[pendingExclusion.accountId], [pendingExclusion.calendarId]: false } })); setPendingExclusion(null); }}>Confirm exclusion</Button></div></DialogContent>
      </Dialog>
    </div>
  </AppPageShell>;
}
