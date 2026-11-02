"use client";

import { PersonSelectionSurface } from "@/components/connections/person-selection-surface";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { CalendarCompactAction } from "./calendar-compact-action";
import presentationStyles from "./calendar-presentation.module.css";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { useVault } from "@/lib/vault/vault-context";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { usePathname } from "next/navigation";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { calendarRefreshKey } from "@/lib/calendar/calendar-refresh";
import { CacheService } from "@/lib/services/cache-service";
import { GoogleCalendarError, type CalendarAttendanceResult, type CalendarInvitation } from "@/lib/services/google-calendar-service";
import { calendarEventPeople, type CalendarHusshPeople } from "@/lib/calendar/calendar-hussh-people";
import { CalendarInvitationActions, type InvitationDecision, type InvitationTerms } from "./calendar-invitation-actions";
import { CalendarInvitationDetail, InvitationAvatar, InvitationDate, invitationDescription, invitationPerson, invitationPersonName } from "./calendar-invitation-detail";
import { calendarDate, shiftCalendarDate, eventTime } from "./calendar-schedule-presentation";
import { CalendarLoading } from "./calendar-loading";
import { CalendarDateNavigation } from "./calendar-date-navigation";
import { invitationResourceKey, invitationSnapshot, loadInvitationResource } from "@/lib/calendar/calendar-invitations-resource";
import styles from "./calendar-invitations.module.css";

import type { CalendarInvitationHandoff, CalendarAttendanceHandoff } from "@/lib/calendar/calendar-invitation-handoff";
type Props = {
  userId: string; accountEmail?: string | null; zone: string; getIdToken: () => Promise<string>;
  accountId?: string;
  initialFilter?: string; initialEventId?: string; initialCalendarId?: string; initialDecision?: InvitationDecision; initialTerms?: InvitationTerms;
  workspaceLayout?: boolean; startAt?: string; endAt?: string; connectionRevision?: number; busy?: boolean;
  calendarPeople?: CalendarHusshPeople;
  onConnect: (access: "read" | "manage", includeCalendarList?: boolean) => void;
  onMailConnect?: () => void; onOfferTimes?: (selection: CalendarInvitationHandoff) => void;
  onSend?: (handoff: CalendarAttendanceHandoff) => void;
  onBusyChange?: (busy: boolean) => void;
  onResult?: (result: CalendarAttendanceResult) => void;
};
const EMPTY_CALENDAR_PEOPLE: CalendarHusshPeople = new Map();

export function CalendarInvitations(props: Props) {
  const { vaultOwnerToken } = useVault();
  return <Invitations key={`${props.userId}:${props.accountId || "default"}:${props.accountEmail}:${props.initialCalendarId}:${props.initialEventId}:${props.initialDecision}:${props.startAt}:${props.endAt}:${JSON.stringify(props.initialTerms)}`} {...props} token={vaultOwnerToken} />;
}

function Invitations({ workspaceLayout = false, calendarPeople, userId, accountId = "default", accountEmail, zone, getIdToken, initialFilter, initialEventId, initialCalendarId, initialDecision, initialTerms, startAt, endAt, connectionRevision, busy, onConnect, onMailConnect, onOfferTimes, onSend, onResult, onBusyChange, token }: Props & { token: string | null }) {
  const [date, setDate] = useState(() => calendarDate(Date.now(), zone));
  // UTC padding covers the selected local day even across DST and extreme offsets.
  const queryStart = workspaceLayout ? `${shiftCalendarDate(date, -1)}T00:00:00Z` : startAt;
  const queryEnd = workspaceLayout ? `${shiftCalendarDate(date, 2)}T00:00:00Z` : endAt;
  const owner = snapshotValidatedAuthSessionOwner();
  const resourceKey = workspaceLayout ? invitationResourceKey(userId, [accountId, accountEmail?.toLowerCase(), owner?.generation, connectionRevision, calendarDate(Date.now(), zone), zone, queryStart, queryEnd, initialCalendarId, initialEventId]) : "";
  const [filter, setFilter] = useState(initialFilter === "all" || initialFilter === "responded" ? initialFilter : "pending");
  const [snapshot, setSnapshot] = useState(() => ({ key: resourceKey, data: invitationSnapshot(resourceKey)?.data ?? null }));
  const data = snapshot.key === resourceKey ? snapshot.data : invitationSnapshot(resourceKey)?.data ?? null;
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(() => !invitationSnapshot(resourceKey));
  const [actionBusy, setActionBusy] = useState(false);
  const people = useMemo(() => calendarEventPeople(calendarPeople ?? EMPTY_CALENDAR_PEOPLE, data?.people, userId), [calendarPeople, data?.people, userId]);
  const profileUserIds = useMemo(() => new Set(actionBusy ? [] : [...calendarPeople?.values() ?? []].map(person => person.userId).filter(id => id !== userId)), [actionBusy, calendarPeople, userId]);
  const actionBusyRef = useRef(false);
  const updateBusy = (value: boolean) => { actionBusyRef.current = value; setActionBusy(value); onBusyChange?.(value); };
  const [selectedId, setSelectedId] = useState(initialEventId && initialCalendarId ? `${initialCalendarId}:${initialEventId}` : null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const request = useRef(0), controller = useRef<AbortController | null>(null), tokenGetter = useRef(getIdToken);
  tokenGetter.current = getIdToken;
  const load = useCallback(async (force = false) => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const number = ++request.current, currentOwner = snapshotValidatedAuthSessionOwner();
    const current = () => !abort.signal.aborted && number === request.current && (!currentOwner || isValidatedAuthSessionOwnerCurrent(currentOwner));
    setError(null);
    const cached = invitationSnapshot(resourceKey);
    if (!force && cached?.isFresh) { setSnapshot({ key: resourceKey, data: cached.data }); setLoading(false); return; }
    setLoading(true);
    try {
      const firebaseIdToken = await tokenGetter.current();
      if (!current()) return;
      const result = await loadInvitationResource(resourceKey, { firebaseIdToken, timeZone: zone, accountId, startAt: queryStart, endAt: queryEnd, selectedCalendarId: initialCalendarId, selectedEventId: initialEventId, signal: abort.signal, isEffectCurrent: current }, accountEmail, force);
      if (current()) setSnapshot({ key: resourceKey, data: result });
    } catch (failure) { if (current()) { setSnapshot({ key: resourceKey, data: null }); setError(failure instanceof Error ? failure : new Error("Invitations could not be loaded.")); } }
    finally { if (current()) setLoading(false); }
  }, [resourceKey, zone, queryStart, queryEnd, accountId, accountEmail, initialCalendarId, initialEventId]);
  useEffect(() => { setSnapshot({ key: resourceKey, data: invitationSnapshot(resourceKey)?.data ?? null }); void load(); return () => { controller.current?.abort(); }; }, [load, resourceKey]);
  useEffect(() => CacheService.getInstance().subscribe(event => { if (event.type === "set" && event.key === calendarRefreshKey(userId)) void load(true); }), [userId, load]);
  const selected = data?.events.find(event => `${event.calendar_id}:${event.id}` === selectedId);
  const close = useCallback(() => { if (actionBusyRef.current) return true; setSelectedId(null); requestAnimationFrame(() => trigger.current?.focus()); return true; }, []);
  const pathname = usePathname();
  useBackLayer(pathname, selected ? 1 : 0, close);
  const invitationDay = (event: CalendarInvitation) => {
    if (event.start?.date) return event.start.date;
    const instant = Date.parse(event.start?.dateTime || "");
    return Number.isFinite(instant) ? calendarDate(instant, zone) : null;
  };
  const dayEvents = data?.events.filter(event => {
    if (!workspaceLayout) return true;
    const firstDay = invitationDay(event);
    const end = Date.parse(event.end?.dateTime || "");
    const lastDay = event.end?.date ? shiftCalendarDate(event.end.date, -1)
      : Number.isFinite(end) ? calendarDate(end - 1, zone) : firstDay;
    return Boolean(firstDay && lastDay && firstDay <= date && date <= lastDay);
  }) || [];
  const filtered = dayEvents.filter(event => filter === "all" || (event.response_status === "needsAction") === (filter === "pending"));
  const pendingCount = workspaceLayout ? dayEvents.filter(event => event.response_status === "needsAction").length : data?.pending_count;
  const navigateDate = (value: string) => { setSelectedId(null); setDate(value); };
  const label = filter === "pending" ? "Needs your response" : filter === "responded" ? "Your responses" : "All invitations";
  const statusLabel = (event: CalendarInvitation) => event.response_status === "needsAction" ? null : event.response_status === "accepted" ? "Accepted" : event.response_status === "declined" ? "Declined" : "Tentative";
  return <section className={styles.invitations} data-workspace={workspaceLayout} data-detail={Boolean(selected)} aria-label="Invitations" aria-busy={loading}>
    <div className={styles.filters}><SegmentedTabs disabled={actionBusy} ariaLabel="Invitation filters" variant="filter" value={filter} onValueChange={value => { setFilter(value); close(); }} options={[{ value: "pending", label: `Pending (${data ? pendingCount : "…"})` }, { value: "responded", label: "Responded" }, { value: "all", label: "All" }]} /></div>
    {workspaceLayout ? <div className={styles.dateNavigation}><CalendarDateNavigation date={date} today={calendarDate(Date.now(), zone)} disabled={actionBusy} onChange={navigateDate} label="Invitation date" /></div> : null}
    {error ? <div role="alert" className="space-y-3"><p>Invitations could not be loaded.</p><p className={styles.muted}>{error.message}</p>{error instanceof GoogleCalendarError && error.recovery !== "retry" ? <CalendarCompactAction disabled={busy} onClick={() => onConnect("manage", error.reasonCode === "calendar_list_permission_required")}>Allow Calendar access</CalendarCompactAction> : <CalendarCompactAction onClick={() => void load(true)}>Retry</CalendarCompactAction>}</div> : !data ? <CalendarLoading label="Invitations loading" /> : <>
      {data.unreadable_calendars.length ? <p className={styles.muted}>Some calendars allow only free/busy access. Their invitation details and conflicts could not be checked.</p> : null}
      <div className={styles.workspace} data-selected={Boolean(selected)}>
        <div className={styles.listPane} aria-label="Invitation list"><h2 className={styles.sectionTitle}>{label}</h2>
          {!filtered.length ? <p className={styles.empty}>No {filter === "all" ? "" : `${filter} `}invitations {workspaceLayout ? "on this date" : "in this window"}.</p> : <ul className={styles.list}>{filtered.map(event => {
            const organizerPerson = invitationPerson(people, event.organizer?.email);
            const organizer = invitationPersonName(organizerPerson, event.organizer?.displayName, event.organizer?.email) || "Organizer";
            const response = statusLabel(event);
            const husshPhoto = organizerPerson?.photoUrl ?? null;
            return <li key={`${event.calendar_id}:${event.id}`}><PersonSelectionSurface type="button" disabled={actionBusy} className={styles.inviteCard} aria-label={`Open invitation: ${event.title}`} aria-pressed={selectedId === `${event.calendar_id}:${event.id}`} onClick={e => { trigger.current = e.currentTarget; setSelectedId(`${event.calendar_id}:${event.id}`); }}>
              <InvitationDate event={event} zone={zone} /><span className={styles.copy}><strong className={styles.title}>{event.title}</strong><span className={styles.muted}>{eventTime(event, zone)}</span><span className={styles.organizer}><InvitationAvatar userId={organizerPerson && profileUserIds.has(organizerPerson.userId) ? organizerPerson.userId : undefined} name={organizer} email={event.organizer?.email} photoUrl={husshPhoto} /><span className={styles.copy}><span>{organizer}</span>{organizer !== event.organizer?.email ? <span className={styles.muted}>{event.organizer?.email}</span> : null}</span></span>{event.description ? <span className={styles.preview}>{invitationDescription(event.description)}</span> : null}{response ? <span className={styles.response} data-response={event.response_status}>{response}</span> : null}{event.conflicts.length ? <span className={styles.conflict}><AlertTriangle aria-hidden className="size-4 shrink-0" />Overlaps {event.conflicts[0]?.title || "another meeting"}</span> : null}</span><ChevronRight aria-hidden className={styles.chevron} />
            </PersonSelectionSurface></li>;
          })}</ul>}
        </div>
        <Dialog modal open={Boolean(selected)} onOpenChange={open => { if (!open) close(); }}>
          <DialogContent className={styles.calendarTypography} data-profile-type-scale="calendar" srDescription="Review this invitation and choose your response." onEscapeKeyDown={event => { if (actionBusyRef.current) event.preventDefault(); }} onInteractOutside={event => { if (actionBusyRef.current) event.preventDefault(); }} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
          <DialogTitle className="sr-only">Invitation details</DialogTitle>
          {selected ? <div className={styles.detailPane}>
          <Button variant="ghost" size="compact" className={`${styles.back} ${presentationStyles.utility}`} disabled={actionBusy} onClick={close}><ChevronLeft aria-hidden className="size-4" />Invitations</Button>
          <CalendarInvitationDetail event={selected} zone={zone} people={people} profileUserIds={profileUserIds} workspaceLayout={workspaceLayout} accountEmail={data.account_email || accountEmail} />
          <CalendarInvitationActions key={`${selected.calendar_id}:${selected.id}:${JSON.stringify(initialTerms)}`} event={selected} userId={userId} token={token} zone={zone} getIdToken={getIdToken} workspaceLayout={workspaceLayout} accountId={accountId} expectedAccountEmail={data.account_email || accountEmail} onBusyChange={updateBusy} initialDecision={initialDecision} initialTerms={initialTerms} onSend={onSend} onConnect={onConnect} onMailConnect={onMailConnect} onOfferTimes={onOfferTimes ? () => onOfferTimes({ ownerId: userId, accountEmail: accountEmail || "", calendarId: selected.calendar_id, eventId: selected.id }) : undefined} onResult={result => {
            onResult?.(result);
            // Keep partial/unknown outcomes visible; only a fully confirmed RSVP
            // leaves the review. The refresh moves it out of Pending.
            if (["accepted", "declined", "tentative"].includes(result.calendar) && !["failed", "unknown"].includes(result.email)) {
              setSelectedId(null);
              requestAnimationFrame(() => trigger.current?.focus());
            }
          }} />
        </div> : null}
          </DialogContent>
        </Dialog>
        {data && initialEventId && !data.events.some(event => event.id === initialEventId && event.calendar_id === initialCalendarId) ? <p role="status" className={styles.muted}>This invitation is no longer in the current window. Ask One to check it again.</p> : null}
      </div>
    </>}
  </section>;
}
