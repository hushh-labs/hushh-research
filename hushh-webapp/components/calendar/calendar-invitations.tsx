"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { useVault } from "@/lib/vault/vault-context";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { usePathname } from "next/navigation";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { calendarRefreshKey } from "@/lib/calendar/calendar-refresh";
import { CacheService } from "@/lib/services/cache-service";
import { GoogleCalendarError, GoogleCalendarService, type CalendarAttendanceResult, type CalendarInvitation, type CalendarInvitationsResponse } from "@/lib/services/google-calendar-service";
import { CalendarInvitationActions, type InvitationDecision, type InvitationTerms } from "./calendar-invitation-actions";
import { CalendarInvitationDetail, InvitationAvatar, InvitationDate, invitationDescription } from "./calendar-invitation-detail";
import { calendarProviderDayUrl, calendarDate, eventTime } from "./calendar-schedule-presentation";
import styles from "./calendar-invitations.module.css";

import type { CalendarInvitationHandoff } from "@/lib/calendar/calendar-invitation-handoff";
type Props = {
  userId: string; accountEmail?: string | null; zone: string; getIdToken: () => Promise<string>;
  initialFilter?: string; initialEventId?: string; initialCalendarId?: string; initialDecision?: InvitationDecision; initialTerms?: InvitationTerms;
  startAt?: string; endAt?: string; connectionRevision?: number; busy?: boolean;
  onConnect: (access: "read" | "manage", includeCalendarList?: boolean) => void;
  onMailConnect?: () => void; onOfferTimes?: (selection: CalendarInvitationHandoff) => void;
  onBusyChange?: (busy: boolean) => void;
  onResult?: (result: CalendarAttendanceResult) => void;
};

export function CalendarInvitations(props: Props) {
  const { vaultOwnerToken } = useVault();
  const epoch = snapshotVaultSessionEpoch();
  return <Invitations key={`${props.userId}:${props.accountEmail}:${epoch}:${props.initialCalendarId}:${props.initialEventId}:${props.initialDecision}:${props.startAt}:${props.endAt}:${JSON.stringify(props.initialTerms)}`} {...props} token={vaultOwnerToken} />;
}

function Invitations({ userId, accountEmail, zone, getIdToken, initialFilter, initialEventId, initialCalendarId, initialDecision, initialTerms, startAt, endAt, connectionRevision, busy, onConnect, onMailConnect, onOfferTimes, onResult, onBusyChange, token }: Props & { token: string | null }) {
  const [filter, setFilter] = useState(initialFilter === "all" || initialFilter === "responded" ? initialFilter : "pending");
  const [data, setData] = useState<CalendarInvitationsResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const actionBusyRef = useRef(false);
  const updateBusy = (value: boolean) => { actionBusyRef.current = value; setActionBusy(value); onBusyChange?.(value); };
  const [selectedId, setSelectedId] = useState(initialEventId && initialCalendarId ? `${initialCalendarId}:${initialEventId}` : null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const request = useRef(0), controller = useRef<AbortController | null>(null), tokenGetter = useRef(getIdToken);
  tokenGetter.current = getIdToken;
  const load = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const number = ++request.current, epoch = snapshotVaultSessionEpoch();
    const current = () => !abort.signal.aborted && number === request.current && isVaultSessionEpochCurrent(epoch);
    setLoading(true); setError(null);
    try {
      const firebaseIdToken = await tokenGetter.current();
      if (!current()) return;
      const result = await GoogleCalendarService.invitations({ firebaseIdToken, timeZone: zone, startAt, endAt, selectedCalendarId: initialCalendarId, selectedEventId: initialEventId, signal: abort.signal, isEffectCurrent: current });
      if (accountEmail && result.account_email && accountEmail.toLowerCase() !== result.account_email.toLowerCase()) throw new GoogleCalendarError("The connected Calendar account changed. Load this invitation again.", "calendar_connection_changed", 409);
      if (current()) setData(result);
    } catch (failure) { if (current()) { setData(null); setError(failure instanceof Error ? failure : new Error("Invitations could not be loaded.")); } }
    finally { if (current()) setLoading(false); }
  }, [zone, startAt, endAt, accountEmail, initialCalendarId, initialEventId]);
  useEffect(() => { void load(); return () => { controller.current?.abort(); }; }, [load, connectionRevision]);
  useEffect(() => CacheService.getInstance().subscribe(event => { if (event.type === "set" && event.key === calendarRefreshKey(userId)) void load(); }), [userId, load]);
  const selected = data?.events.find(event => `${event.calendar_id}:${event.id}` === selectedId);
  const close = useCallback(() => { if (actionBusyRef.current) return true; setSelectedId(null); requestAnimationFrame(() => trigger.current?.focus()); return true; }, []);
  const pathname = usePathname();
  useBackLayer(pathname, selected ? 1 : 0, close);
  const filtered = data?.events.filter(event => filter === "all" || (event.response_status === "needsAction") === (filter === "pending")) || [];
  const label = filter === "pending" ? "Needs your response" : filter === "responded" ? "Your responses" : "All invitations";
  const statusLabel = (event: CalendarInvitation) => event.response_status === "needsAction" ? null : event.response_status === "accepted" ? "Accepted" : event.response_status === "declined" ? "Declined" : "Tentative";
  return <section className={styles.invitations} aria-label="Invitations" aria-busy={loading}>
    <div className={styles.filters}><SegmentedTabs disabled={actionBusy} ariaLabel="Invitation filters" variant="filter" value={filter} onValueChange={value => { setFilter(value); close(); }} options={[{ value: "pending", label: `Pending (${data?.pending_count ?? "…"})` }, { value: "responded", label: "Responded" }, { value: "all", label: "All" }]} /></div>
    {error ? <div role="alert" className="space-y-3"><p>Invitations could not be loaded.</p><p className={styles.muted}>{error.message}</p>{error instanceof GoogleCalendarError && error.recovery !== "retry" ? <Button disabled={busy} variant="outline" onClick={() => onConnect("read", error.reasonCode === "calendar_list_permission_required")}>Allow Calendar access</Button> : <Button variant="outline" onClick={() => void load()}>Retry</Button>}</div> : !data ? <p role="status" className={styles.muted}>Loading invitations…</p> : <>
      {data.unreadable_calendars.length ? <p className={styles.muted}>Some calendars allow only free/busy access. Their invitation details and conflicts could not be checked.</p> : null}
      <div className={styles.workspace} data-selected={Boolean(selected)}>
        <div className={styles.listPane}><h2 className={styles.sectionTitle}>{label}</h2><p className={styles.range}>Next {Math.max(1, Math.ceil((Date.parse(data.end_at) - Date.parse(data.start_at)) / 86400000))} days</p>
          {!filtered.length ? <p className={styles.empty}>No {filter === "all" ? "upcoming" : filter} invitations in this window.</p> : <ul className={styles.list}>{filtered.map((event, index) => {
            const organizer = event.organizer?.displayName || event.organizer?.email || "Organizer";
            const response = statusLabel(event);
            return <li key={`${event.calendar_id}:${event.id}`}><button type="button" disabled={actionBusy} className={styles.inviteCard} aria-label={`Open invitation: ${event.title}`} aria-pressed={selectedId === `${event.calendar_id}:${event.id}`} onClick={e => { trigger.current = e.currentTarget; setSelectedId(`${event.calendar_id}:${event.id}`); }}>
              <InvitationDate event={event} zone={zone} /><span className={styles.copy}><strong className={styles.title}>{event.title}</strong><span className={styles.muted}>{eventTime(event, zone)}</span><span className={styles.organizer}><InvitationAvatar name={organizer} index={index} /><span className={styles.copy}><span>{organizer}</span>{event.organizer?.displayName ? <span className={styles.muted}>{event.organizer.email}</span> : null}</span></span>{event.description ? <span className={styles.preview}>{invitationDescription(event.description)}</span> : null}{response ? <span className={styles.response} data-response={event.response_status}>{response}</span> : null}{event.conflicts.length ? <span className={styles.conflict}><AlertTriangle aria-hidden className="size-4 shrink-0" />Overlaps {event.conflicts[0]?.title || "another meeting"}</span> : null}</span><ChevronRight aria-hidden className={styles.chevron} />
            </button></li>;
          })}</ul>}
          <a className={styles.providerShortcut} href={calendarProviderDayUrl(calendarDate(Date.now(), zone), accountEmail)} target="_blank" rel="noopener noreferrer"><span><CalendarDays aria-hidden className="size-5" /></span><span className={styles.copy}><strong>View all invitations</strong><small>See more in Google Calendar</small></span><ChevronRight aria-hidden className="size-5" /></a>
        </div>
        {selected ? <div className={`${styles.detailPane} motion-step-enter`}>
          <Button variant="ghost" className={styles.back} disabled={actionBusy} onClick={close}><ChevronLeft aria-hidden className="size-4" />Invitations</Button>
          <CalendarInvitationDetail event={selected} zone={zone} />
          <CalendarInvitationActions key={`${selected.calendar_id}:${selected.id}:${JSON.stringify(initialTerms)}`} event={selected} userId={userId} token={token} zone={zone} getIdToken={getIdToken} expectedAccountEmail={data.account_email || accountEmail} onBusyChange={updateBusy} initialDecision={initialDecision} initialTerms={initialTerms} onConnect={onConnect} onMailConnect={onMailConnect} onOfferTimes={onOfferTimes ? () => onOfferTimes({ ownerId: userId, accountEmail: accountEmail || "", calendarId: selected.calendar_id, eventId: selected.id }) : undefined} onResult={onResult} />
        </div> : initialEventId ? <p role="status" className={styles.muted}>This invitation is no longer in the current window. Ask One to check it again.</p> : null}
      </div>
    </>}
  </section>;
}
