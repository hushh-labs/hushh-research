"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle, ChevronDown, Clock, MoreHorizontal, Plus, RefreshCw } from "@/components/icons";
import { Cake, Confetti } from "@/components/icons/ui/calendar-occasion-icons";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useCoarseClock, usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { notifyCalendarChanged, calendarRefreshKey } from "@/lib/calendar/calendar-refresh";
import { CacheService } from "@/lib/services/cache-service";
import { ROUTES } from "@/lib/navigation/routes";
import { safeMeetingUrl } from "@/lib/calendar/calendar-url";
import { isCalendarEventEnded } from "@/lib/calendar/calendar-event-status";
import { boardOccasionKind, isCountedBoardEvent } from "@/lib/calendar/calendar-board-event";
import { googleAvatarSource } from "@/lib/profile/provider-avatar";
import { connectionAvatarInitials } from "@/components/connections/connection-person-avatar";
import type { CalendarSlotHandoff } from "@/lib/calendar/calendar-slot-handoff";
import { GoogleCalendarService, type CalendarBoardAccount, type CalendarBoardConflict, type CalendarBoardDay, type CalendarEventSummary, type CalendarInvitation, type GoogleCalendarStatus } from "@/lib/services/google-calendar-service";
import { CalendarDateNavigation } from "./calendar-date-navigation";
import { CalendarInvitationActions } from "./calendar-invitation-actions";
import { CalendarConflictPanel } from "./calendar-conflict-panel";
import { CalendarCompactAction } from "./calendar-compact-action";
import { CalendarInvitations } from "./calendar-invitations";
import { CalendarInsights } from "./calendar-insights";
import { calendarDate, eventTime, availabilityTimeRangeLabel, calendarResponse, CalendarMeetingIcon, meetingProvider } from "./calendar-schedule-presentation";
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
const BOARD_MIN_OPENING_MINUTES = 15;
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
function accountEmailParts(email: string): [string, string] {
  const at = email.lastIndexOf("@");
  return at > 0 ? [email.slice(0, at), email.slice(at)] : [email, ""];
}

function JoinVideoIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="6" width="13" height="12" rx="2.5" /><path d="m15.5 10 6-3v10l-6-3" /></svg>;
}

export function CalendarAccountBoard({ userId, status, busy, connectionRevision, connectionNotice, token, getIdToken, onAddAccount, onReconnectAccount, onDisconnectAccount, onConnect, onMailConnect, onChat }: Props) {
  const [zone, setZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const now = Math.max(Date.now(), useCoarseClock(60_000));
  const today = calendarDate(now, zone);
  const [date, setDate] = useState(today);
  const [tab, setTab] = useState<"board" | "invitations" | "insights">("board");
  const [invitationAccount, setInvitationAccount] = useState(status.accounts?.[0]?.account_id || "default");
  const [views, setViews] = useState<Record<string, "events" | "free">>({});
  const [revision, setRevision] = useState(0);
  const epoch = snapshotVaultSessionEpoch();
  const accountGeneration = (status.accounts || []).map(account => `${account.account_id}:${account.status}:${account.google_email}:${account.access_level}:${account.calendar_list_access}`).join("|");
  const key = `${userId}:${date}:${zone}:${epoch}:${connectionRevision || 0}:${accountGeneration}`;
  const requestKey = `${key}:${revision}`;
  const currentKey = useRef(requestKey); currentKey.current = requestKey;
  const request = useRef(0);
  const tokenGetter = useRef(getIdToken); tokenGetter.current = getIdToken;
  const [snapshot, setSnapshot] = useState<{ key: string; value: CalendarBoardDay | null; error: string | null }>({ key: "", value: null, error: null });
  const board = snapshot.key === key ? snapshot.value : null;
  const error = snapshot.key === key ? snapshot.error : null;
  const loading = snapshot.key !== key;
  const [selected, setSelected] = useState<Selection | null>(null);
  const [occasionAccountId, setOccasionAccountId] = useState<string | null>(null);
  const occasionAccount = board?.accounts.find(account => account.account_id === occasionAccountId);
  const occasionEvents = occasionAccount?.events.filter(event => boardOccasionKind(event) !== null) || [];
  const [resolving, setResolving] = useState(false);
  const [conflictDraft, setConflictDraft] = useState<{ selected: string[]; notes: Record<string, string> }>({ selected: [], notes: {} });
  const selectedRef = useRef<Selection | null>(null); selectedRef.current = selected;
  const refreshOnClose = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const syncZone = () => {
      const nextZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      if (nextZone === zone) return;
      if (date === calendarDate(Date.now(), zone)) setDate(calendarDate(Date.now(), nextZone));
      setZone(nextZone);
    };
    const onVisibility = () => { if (document.visibilityState === "visible") syncZone(); };
    window.addEventListener("focus", syncZone);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.removeEventListener("focus", syncZone); document.removeEventListener("visibilitychange", onVisibility); };
  }, [date, zone]);

  useEffect(() => {
    const controller = new AbortController();
    const number = ++request.current;
    const isCurrent = () => !controller.signal.aborted && currentKey.current === requestKey && number === request.current && isVaultSessionEpochCurrent(epoch);
    void (async () => {
      try {
        const firebaseIdToken = await tokenGetter.current();
        if (!isCurrent()) return;
        const value = await GoogleCalendarService.boardDay({ firebaseIdToken, date, timeZone: zone, durationMinutes: BOARD_MIN_OPENING_MINUTES, signal: controller.signal, isEffectCurrent: isCurrent });
        if (isCurrent()) setSnapshot({ key, value, error: null });
      } catch (failure) {
        if (isCurrent()) setSnapshot(previous => ({ key, value: previous.key === key ? previous.value : null, error: failure instanceof Error ? failure.message : "Calendar could not be checked." }));
      }
    })();
    return () => { controller.abort(); request.current += 1; };
  }, [requestKey, key, date, zone, epoch]);
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
  const organizerEmail = selectedEvent?.organizer?.email;
  const selectedOrganizer = selectedEvent?.organizer?.displayName?.trim()
    || (organizerEmail && organizerEmail.toLowerCase() === selectedAccount?.google_email?.toLowerCase() ? "you" : organizerEmail);
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
      durationMinutes: BOARD_MIN_OPENING_MINUTES, timeZone: zone,
    });
  };

  return <AppPageShell width="agent" headerContentSpacing="compact" className={styles.shell} nativeTest={{ routeId: ROUTES.CALENDAR, marker: "native-route-calendar", authState: "authenticated", dataState: loading ? "loading" : error ? "error" : board?.complete ? "loaded" : "unavailable-valid" }}>
    <div className={styles.content} data-calendar-account-board data-calendar-presentation>
      <PageHeader title="Calendar" titleRole="agent" titleVisuallyHidden actionsInlineMobile
        description={<span className={styles.description}>{status.accounts?.length || accounts.length} of 3 Google accounts added</span>}
        actions={<div className={styles.headerActions}>
          <CalendarCompactAction disabled={busy || actionBusy || (status.accounts?.length || 0) >= 3} onClick={onAddAccount}><Plus aria-hidden className="size-4" />Add account</CalendarCompactAction>
          <Button variant="ghost" size="icon" aria-label="Refresh all Calendar accounts" disabled={busy || actionBusy} onClick={() => setRevision(value => value + 1)}><RefreshCw aria-hidden className="size-5" /></Button>
        </div>} />
      {connectionNotice}
      <div className={styles.topTabs}><SegmentedTabs ariaLabel="Calendar sections" value={tab} onValueChange={value => setTab(value as typeof tab)} options={[{ value: "board", label: "Board" }, { value: "invitations", label: "Invitations" }, { value: "insights", label: "Insights" }]} /></div>
      {tab === "board" ? <>
        <div className={styles.toolbar}>
          <CalendarDateNavigation date={date} today={today} disabled={busy || actionBusy} onChange={setDate} label="Calendar board date" />
        </div>
        {loading ? <SurfaceCard className={styles.message} role="status">Checking all connected calendars…</SurfaceCard> : !board && error ? <SurfaceCard className={styles.message} role="alert"><p>{error}</p><CalendarCompactAction onClick={() => setRevision(value => value + 1)}>Retry</CalendarCompactAction></SurfaceCard> : board ? <>
          {error ? <SurfaceCard className={styles.message} role="alert"><p>Latest refresh failed: {error}. Times below were last checked {checkedAt || "earlier"}.</p><CalendarCompactAction onClick={() => setRevision(value => value + 1)}>Retry</CalendarCompactAction></SurfaceCard> : null}
          <div className={styles.summary} role="status">
            {board.conflicts_complete && !error ? <>{board.conflicts.length ? <AlertTriangle aria-hidden className="size-4" /> : <CheckCircle aria-hidden className={`${styles.clearIcon} size-4`} />}<strong>{board.conflicts.length} cross-account overlap{board.conflicts.length === 1 ? "" : "s"}</strong></> : <><AlertTriangle aria-hidden className="size-4" /><strong>Conflict check incomplete</strong></>}
            <span>{checkedAt ? `Checked ${checkedAt}` : "Checking"}</span>
          </div>
          <div className={styles.accounts} data-count={accounts.length}>
            {accounts.map((account, index) => {
              const view = views[account.account_id] || "events";
              const meetings = account.events.filter(isCountedBoardEvent);
              const occasions = account.events.filter(event => boardOccasionKind(event) !== null);
              const otherItems = account.events.filter(event => !isCountedBoardEvent(event) && boardOccasionKind(event) === null);
              const scrollEvents = meetings.length + otherItems.length > 3;
              const [accountName, accountDomain] = accountEmailParts(account.google_email);
              const photoUrl = account.profile_photo_url ?? status.accounts?.find(item => item.account_id === account.account_id)?.profile_photo_url;
              const safePhotoUrl = photoUrl ? googleAvatarSource(photoUrl)?.href : null;
              const renderEvent = (event: CalendarEventSummary) => {
                const choice: Selection = { accountId: account.account_id, calendarId: event.calendar_id || "primary", eventId: event.id || "" };
                const count = board.conflicts.filter(pair => pairIncludes(pair, choice)).length;
                const join = safeMeetingUrl(event.conference_url);
                const ended = isCalendarEventEnded(event, now, zone);
                const provider = meetingProvider(event);
                const response = calendarResponse(event, account.google_email);
                const sourceIncluded = account.calendar_options?.find(calendar => calendar.id === (event.source_calendar_id || event.calendar_id))?.availability_default_included !== false;
                const source = provider || (event.event_type === "birthday" ? account.google_email : event.calendar_name || "Primary calendar");
                const eventStatus = event.status === "cancelled" ? "Cancelled"
                  : response === "declined" ? "Declined · not busy"
                  : event.transparency === "transparent" ? "Doesn’t block time"
                  : !sourceIncluded ? "Not counted in free time"
                  : response === "tentative" ? "Tentative" : null;
                return <li key={eventIdentity(event)} className={styles.eventRow} data-ended={ended || undefined}>
                  <button type="button" className={styles.eventMain} onClick={button => open(event, button.currentTarget)} aria-label={`Open ${event.title} in ${accountLabel(account.google_email)}`}>
                    <span className={styles.eventCopy}><strong title={event.title}>{event.title}</strong><span>{eventTime(event, zone)}</span><small className={styles.eventSource}>{provider ? <CalendarMeetingIcon provider={provider} /> : null}<span title={source}>{source}</span></small>{eventStatus ? <small className={styles.eventStatus}>{eventStatus}</small> : null}</span>
                  </button>
                  <div className={styles.eventActions}>
                    {ended ? <span className={styles.eventEnded}><Clock aria-hidden className="size-3" />Ended</span> : join ? <a className={styles.eventJoin} href={join} target="_blank" rel="noopener noreferrer" aria-label={`Join meeting: ${event.title}`}><JoinVideoIcon />Join</a> : null}
                    {count ? <button type="button" className={styles.conflictButton} aria-label={`Review ${count} overlapping meeting${count === 1 ? "" : "s"} for ${event.title} in ${accountLabel(account.google_email)}`} onClick={button => open(event, button.currentTarget)}><AlertTriangle aria-hidden className="size-4" /><span>{count}</span></button> : null}
                  </div>
                </li>;
              };
              return <SurfaceCard key={account.account_id} role="group" aria-label={`Calendar account ${accountLabel(account.google_email)}`} className={styles.account} data-account-index={index}>
                <div className={styles.accountHeader}>
                  <Avatar className={styles.accountAvatar} data-photo-url={safePhotoUrl || undefined}>{safePhotoUrl ? <AvatarImage src={safePhotoUrl} alt="" referrerPolicy="no-referrer" /> : null}<AvatarFallback aria-hidden="true">{connectionAvatarInitials(accountName)}</AvatarFallback></Avatar>
                  <div className={styles.accountIdentity} title={account.google_email}><div className={styles.accountName}>{accountName}</div>{accountDomain ? <span className={styles.accountDomain}>{accountDomain}</span> : null}</div>
                  <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${accountLabel(account.google_email)}`}><MoreHorizontal aria-hidden className="size-5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onDisconnectAccount(account.account_id)}>Disconnect this Calendar account</DropdownMenuItem>
                  </DropdownMenuContent></DropdownMenu>
                </div>
                <p className={styles.connectionState} data-status={account.status}><span aria-hidden="true" />{account.status === "complete" ? "Connected" : account.status === "needs_reauth" ? "Reconnect needed" : "Check incomplete"}</p>
                <div className={styles.accountTabs}><SegmentedTabs ariaLabel={`View for ${accountLabel(account.google_email)}`} variant="filter" value={view} onValueChange={value => setViews(current => ({ ...current, [account.account_id]: value as "events" | "free" }))} options={[{ value: "events", label: `Events (${account.events.length})` }, { value: "free", label: "Free time" }]} /></div>
                {account.status !== "complete" ? <div className={styles.accountError} role="status"><AlertTriangle aria-hidden className="size-4" /><p>{account.error || "This account could not be checked. Its time is excluded from shared availability."}</p><CalendarCompactAction onClick={() => account.status === "needs_reauth" || account.reason_code?.includes("reauth") ? account.account_id === "default" ? onConnect("read", true) : onReconnectAccount(account.account_id) : setRevision(value => value + 1)}>{account.status === "needs_reauth" || account.reason_code?.includes("reauth") ? "Reconnect" : "Retry check"}</CalendarCompactAction></div> : view === "events" ? <div className={styles.accountStream}>
                  {account.unreadable_calendars.length ? <p className={styles.coverage}>Event details unavailable for {account.unreadable_calendars.map(calendar => calendar.name || calendar.id).join(", ")}. Busy time is still checked.</p> : null}
                  <div className={styles.eventBreakdown}><span>{meetings.length} meeting{meetings.length === 1 ? "" : "s"}</span>{occasions.length ? <button type="button" onClick={() => setOccasionAccountId(account.account_id)} aria-label={`View ${occasions.length} occasion${occasions.length === 1 ? "" : "s"} for ${accountLabel(account.google_email)}`}><span className={styles.occasionIcons} aria-hidden="true">{occasions.some(event => boardOccasionKind(event) === "birthday") ? <Cake /> : null}{occasions.some(event => boardOccasionKind(event) === "holiday") ? <Confetti /> : null}</span>{occasions.length} occasion{occasions.length === 1 ? "" : "s"}</button> : null}</div>
                  <div className={styles.eventViewport} role="region" aria-label={`Calendar events for ${accountLabel(account.google_email)}`} tabIndex={scrollEvents ? 0 : undefined} data-scrollable={scrollEvents || undefined}>
                  {meetings.length ? <div className={styles.meetingViewport} role="region" aria-label={`Events for ${accountLabel(account.google_email)}`}><ul className={styles.eventList}>{meetings.map(renderEvent)}</ul></div> : !otherItems.length && !occasions.length ? <p className={styles.empty}>No readable events on this day.</p> : null}
                  {otherItems.length ? <div className={styles.otherViewport} role="region" aria-label={`Other calendar items for ${accountLabel(account.google_email)}`}><ul className={styles.eventList}>{otherItems.map(renderEvent)}</ul></div> : null}
                  </div>
                </div> : <div className={styles.freeStream} role="region" tabIndex={0} aria-label={`Free time for ${accountLabel(account.google_email)}`}>
                  {account.free_windows.length ? <ul className={styles.freeList}>{account.free_windows.map(window => <li key={`${window.start_at}:${window.end_at}`}><Clock aria-hidden className="size-4" /><span>{availabilityTimeRangeLabel(window.start_at, window.end_at, zone, date)}</span></li>)}</ul> : <p className={styles.empty}>No free time on this day.</p>}
                </div>}
              </SurfaceCard>;
            })}
          </div>
          <SurfaceCard className={styles.shared}>
            <div className={styles.sharedTitle}><CheckCircle aria-hidden className="size-5" /><div><h2>Free across all accounts</h2>{!board.complete || error ? <p>Availability is incomplete until every account is checked.</p> : null}</div></div>
            {board.complete && !error ? board.shared_free_windows.length ? <><ul className={styles.sharedList}>{board.shared_free_windows.map(window => <li key={`${window.start_at}:${window.end_at}`}>{sharedHandoffAvailable ? <button type="button" disabled={busy} onClick={() => selectSharedWindow(window)} aria-label={`Use shared free time ${availabilityTimeRangeLabel(window.start_at, window.end_at, zone, date)}`}>{availabilityTimeRangeLabel(window.start_at, window.end_at, zone, date)}<span>Use this time</span></button> : availabilityTimeRangeLabel(window.start_at, window.end_at, zone, date)}</li>)}</ul>{!sharedHandoffAvailable ? <p className={styles.readOnly}>These openings were checked across the connected accounts. Refresh before scheduling because availability can change.</p> : null}</> : <p>No shared opening on this day.</p> : <p role="alert">Reconnect or refresh the affected account before relying on shared free time.</p>}
          </SurfaceCard>
        </> : null}
      </> : tab === "invitations" ? <section className={styles.secondary} aria-label="Invitations">
        <label className={styles.accountPicker}>Calendar account<span className={styles.accountPickerControl}><select value={invitationAccount} onChange={event => setInvitationAccount(event.target.value)}>{(status.accounts || []).map(account => <option key={account.account_id} value={account.account_id}>{accountLabel(account.google_email)}</option>)}</select><ChevronDown aria-hidden="true" className={styles.accountPickerChevron} /></span></label>
        {status.accounts?.find(account => account.account_id === invitationAccount)?.connected ? <CalendarInvitations key={invitationAccount} workspaceLayout connectedProfiles userId={userId} accountId={invitationAccount} accountEmail={status.accounts.find(account => account.account_id === invitationAccount)?.google_email} accountPhotoUrl={status.accounts.find(account => account.account_id === invitationAccount)?.profile_photo_url} zone={zone} getIdToken={getIdToken} busy={busy} connectionRevision={connectionRevision} onConnect={invitationAccount === "default" ? onConnect : () => onReconnectAccount(invitationAccount)} onMailConnect={onMailConnect} onResult={() => { notifyCalendarChanged(userId); setRevision(value => value + 1); }} /> : <p role="alert">Reconnect this account to see its invitations.</p>}
      </section> : <section className={styles.secondary} aria-label="Calendar insights">
        {board ? <SurfaceCard className={styles.insightSummary}><h2>Across your connected accounts today</h2><p>{board.accounts.reduce((sum, account) => sum + account.events.filter(isCountedBoardEvent).length, 0)} events · {board.conflicts.length} cross-account overlaps · {board.complete ? `${board.shared_free_windows.length} shared openings` : "shared availability incomplete"}</p></SurfaceCard> : null}
        {defaultConnected ? <CalendarInsights key={`${userId}:default:${epoch}:${zone}`} userId={userId} accountKey={`${status.google_email}:default:${connectionRevision || 0}`} date={today} zone={zone} getIdToken={getIdToken} vaultOwnerToken={token} /> : <p>Weekly insights for the default Google account are available when that account is connected.</p>}
      </section>}
      <div className={styles.footer}><Button onClick={() => onChat()} disabled={busy}>Try Calendar Agent with One</Button></div>
      <Dialog modal open={Boolean(occasionAccount && occasionEvents.length)} onOpenChange={isOpen => { if (!isOpen) setOccasionAccountId(null); }}>
        <DialogContent className={styles.occasionDialog}>
          {occasionAccount ? <>
            <DialogHeader className={styles.occasionHeader}><DialogTitle>Occasions</DialogTitle><DialogDescription>{accountLabel(occasionAccount.google_email)}</DialogDescription></DialogHeader>
            <ul className={styles.occasionList}>{occasionEvents.map(event => {
              const kind = boardOccasionKind(event);
              return <li key={eventIdentity(event)} className={styles.occasionItem} data-kind={kind || undefined}>
                <span className={styles.occasionIcon} aria-hidden="true">{kind === "birthday" ? <Cake /> : <Confetti />}</span>
                <div className={styles.occasionCopy}><strong>{event.title}</strong><span>{kind === "birthday" ? "Birthday" : "Holiday"} · {eventTime(event, zone)}</span>{event.location ? <span>{event.location}</span> : null}{event.description ? <p>{event.description}</p> : null}</div>
              </li>;
            })}</ul>
          </> : null}
        </DialogContent>
      </Dialog>
      <Dialog modal open={Boolean(selected && selectedEvent)} onOpenChange={isOpen => { if (!isOpen) close(); }}>
        <DialogContent className={styles.detail} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }} onEscapeKeyDown={event => { if (actionBusy) event.preventDefault(); }} onInteractOutside={event => { if (actionBusy) event.preventDefault(); }}>
          {selected && selectedEvent && selectedAccount ? <>
            <DialogHeader className={styles.detailHeader}><DialogTitle className={styles.detailTitle}>{resolving ? "Resolve overlapping meetings" : selectedEvent.title}</DialogTitle><DialogDescription>{accountLabel(selectedAccount.google_email)} · {eventTime(selectedEvent, zone)}</DialogDescription>{!resolving && isCalendarEventEnded(selectedEvent, now, zone) ? <span className={styles.detailEnded}><Clock aria-hidden className="size-3" />Ended</span> : null}{!resolving && selectedOrganizer ? <p className={styles.detailSource}>Organized by {selectedOrganizer}</p> : null}</DialogHeader>
            {resolving && board ? <CalendarConflictPanel key={identity(selected)} board={board} keep={{ account_id: selected.accountId, calendar_id: selected.calendarId, event_id: selected.eventId }} token={token} getIdToken={getIdToken} initialDraft={conflictDraft} onDraftChange={setConflictDraft} onBusyChange={setActionBusy} onChooseKeep={ref => setSelected({ accountId: ref.account_id, calendarId: ref.calendar_id, eventId: ref.event_id })} onMailConnect={onMailConnect} onConfirmed={() => { refreshOnClose.current = true; }} onDone={close} /> : <>
            {selectedEvent.location ? <p className={styles.detailSource}>Location: {selectedEvent.location}</p> : null}
            {selectedEvent.description ? <p className={styles.detailDescription}>{selectedEvent.description}</p> : null}
            {!isCalendarEventEnded(selectedEvent, now, zone) && safeMeetingUrl(selectedEvent.conference_url) ? <a className={styles.join} href={safeMeetingUrl(selectedEvent.conference_url)!} target="_blank" rel="noopener noreferrer">Join meeting</a> : null}
            {overlaps.length ? <div className={styles.overlapDetail}><h3><AlertTriangle aria-hidden className="size-4" />Overlapping meetings</h3>{overlaps.map(pair => { const other = otherSide(pair, selected); const event = findEvent({ accountId: other.account_id, calendarId: other.calendar_id, eventId: other.event_id }); const account = accounts.find(item => item.account_id === other.account_id); return <div key={identity(other)} className={styles.overlapItem}><strong>{event?.title || "Another meeting"}</strong><p>{accountLabel(account?.google_email || null)} · {event ? eventTime(event, zone) : "Time unavailable"}</p><p>Overlap: {availabilityTimeRangeLabel(pair.start_at, pair.end_at, zone, date)}</p></div>; })}{!board?.conflicts_complete || error ? <p role="alert">Refresh every account before resolving conflicts.</p> : <CalendarCompactAction disabled={actionBusy || busy} onClick={() => setResolving(true)}>Resolve these overlaps</CalendarCompactAction>}</div> : null}
            {selectedEvent.can_decline ? <CalendarInvitationActions key={eventIdentity(selectedEvent)} event={toInvitation(selectedEvent, selectedAccount)} userId={userId} accountId={selectedAccount.account_id} token={token} zone={zone} getIdToken={getIdToken} expectedAccountEmail={selectedAccount.google_email} onBusyChange={setActionBusy} onConnect={selectedAccount.account_id === "default" ? onConnect : () => onReconnectAccount(selectedAccount.account_id)} onMailConnect={onMailConnect} onResult={() => { refreshOnClose.current = true; }} /> : <p className={styles.readOnly}>This event stays on its calendar. Attendance changes are available for invitations to this account.</p>}
            </>}
          </> : null}
        </DialogContent>
      </Dialog>
    </div>
  </AppPageShell>;
}
