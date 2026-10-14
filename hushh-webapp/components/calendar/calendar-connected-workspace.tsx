"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle, ChevronLeft, ChevronRight, Lock, MoreHorizontal, Plus } from "@/components/icons";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { TopShellTabs } from "@/components/app-ui/top-shell-tabs";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import { AskOneButton } from "@/components/agent/ask-one-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { useVault } from "@/lib/vault/vault-context";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { ROUTES } from "@/lib/navigation/routes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { useCoarseClock, usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { safeMeetingUrl } from "@/lib/calendar/calendar-url";
export { safeMeetingUrl } from "@/lib/calendar/calendar-url";
import { GoogleCalendarService, GoogleCalendarError, type CalendarEventSummary, type CalendarSource, type CalendarAvailability, type CalendarAttendanceReview, type CalendarAttendanceResult, type GoogleCalendarStatus } from "@/lib/services/google-calendar-service";
import { CalendarAvailabilityArt, CalendarHelperIcon, CalendarProviderShortcut, CalendarTimelineRow, GoogleCalendarMark, calendarDate, calendarDayLabel, calendarProviderDayUrl, durationLabel, eventTime, shiftCalendarDate, timeRangeLabel } from "./calendar-schedule-presentation";
export { calendarDate } from "./calendar-schedule-presentation";
import scheduleStyles from "./calendar-schedule.module.css";

const MAIN_TABS = [
  { value: "schedule", label: "Schedule", href: "/one/calendar" },
  { value: "invitations", label: "Invitations", href: "/one/calendar" },
  { value: "insights", label: "Insights", href: "/one/calendar" },
];
const SCHEDULE_TABS = [{ value: "today", label: "Today" }, { value: "free", label: "Free time" }];


function formatFailure(error: unknown): Error {
  return error instanceof Error ? error : new Error("Calendar could not be checked. Try again.");
}

type Props = {
  userId: string;
  status: GoogleCalendarStatus;
  busy: boolean;
  onConnect: (access: "read" | "manage", includeCalendarList?: boolean) => void;
  onChat: (prompt?: string) => void;
  onDisconnect: () => void;
  onMailConnect?: () => Promise<void>;
  connectionNotice?: ReactNode;
  getIdToken: () => Promise<string>;
  connectionRevision?: number;
};

/** Schedule uses signed-in Google consent; attendance retains vault-owner authority. */
export function CalendarConnectedWorkspace(props: Props) {
  const { vaultOwnerToken, ownerTokenStatus } = useVault();
  return <ConnectedSchedule key={props.userId} {...props} token={vaultOwnerToken} ownerTokenStatus={ownerTokenStatus} />;
}

function ConnectedSchedule({ status, busy, onConnect, onChat, onDisconnect, onMailConnect, connectionNotice, getIdToken, connectionRevision, token, ownerTokenStatus }: Props & { token: string | null; ownerTokenStatus: "locked" | "valid" | "renewing" | "unavailable" }) {
  const getIdTokenRef = useRef(getIdToken);
  getIdTokenRef.current = getIdToken;
  const [tab, setTab] = useState("schedule");
  const [view, setView] = useState("today");
  const [zone, setZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [zoneInput, setZoneInput] = useState(zone);
  const [zoneError, setZoneError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsStart, setSettingsStart] = useState("09:00");
  const [settingsEnd, setSettingsEnd] = useState("17:00");
  const [entryTime] = useState(() => Date.now());
  const now = Math.max(entryTime, useCoarseClock(60_000));
  const today = calendarDate(now, zone);
  const [date, setDate] = useState(today);
  const [alternativeDate, setAlternativeDate] = useState(today);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [duration, setDuration] = useState<15 | 30 | 60>(15);
  const epoch = snapshotVaultSessionEpoch();
  const eventKey = `${date}:${zone}:${epoch}:${status.google_email}:${connectionRevision || 0}:${status.access_level}:${status.calendar_list_access}`;
  const availabilityKey = `${date}:${zone}:${startTime}:${endTime}:${duration}:${epoch}:${status.google_email}:${connectionRevision || 0}:${status.access_level}:${status.calendar_list_access}`;
  const [eventStateKey, setEventStateKey] = useState("");
  const [availabilityStateKey, setAvailabilityStateKey] = useState("");
  const [storedEvents, setEvents] = useState<CalendarEventSummary[] | null>(null);
  const [unreadableCalendars, setUnreadableCalendars] = useState<CalendarSource[]>([]);
  const [storedEventsError, setEventsError] = useState<Error | null>(null);
  const [storedEventsLoading, setEventsLoading] = useState(false);
  const [storedAvailability, setAvailability] = useState<CalendarAvailability | null>(null);
  const [storedAvailabilityError, setAvailabilityError] = useState<Error | null>(null);
  const [storedAvailabilityLoading, setAvailabilityLoading] = useState(false);
  // A changed window must hide old snapshots in the render itself, before
  // passive-effect cleanup or an earlier network response can settle.
  const events = eventStateKey === eventKey ? storedEvents : null;
  const eventsError = eventStateKey === eventKey ? storedEventsError : null;
  const eventsLoading = eventStateKey !== eventKey || storedEventsLoading;
  const availability = availabilityStateKey === availabilityKey ? storedAvailability : null;
  const availabilityError = availabilityStateKey === availabilityKey ? storedAvailabilityError : null;
  const availabilityLoading = availabilityStateKey !== availabilityKey || storedAvailabilityLoading;
  const [storedSelected, setSelected] = useState<CalendarEventSummary | null>(null);
  const [selectedEpoch, setSelectedEpoch] = useState(epoch);
  const [selectedEmail, setSelectedEmail] = useState(status.google_email);
  const selected = selectedEpoch === epoch && selectedEmail === status.google_email ? storedSelected : null;
  const [step, setStep] = useState<"details" | "choice" | "review" | "result">("details");
  const [offerTimes, setOfferTimes] = useState(false);
  const [message, setMessage] = useState("I can't attend our meeting. Please choose another time using the link below and update the invitation.");
  const [review, setReview] = useState<CalendarAttendanceReview | null>(null);
  const [result, setResult] = useState<CalendarAttendanceResult | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement | null>(null);
  const accountMenuButton = useRef<HTMLButtonElement | null>(null);
  const settingsTrigger = useRef<HTMLButtonElement | null>(null);
  const selection = useRef<{ event: CalendarEventSummary; token: string | null; email: string | null | undefined } | null>(null);
  const eventRequest = useRef(0), availabilityRequest = useRef(0);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => { controller.abort(); };
  }, []);
  const windowParams = { vaultOwnerToken: token || "", date: alternativeDate, timeZone: zone, startTime, endTime, durationMinutes: duration };

  const loadEvents = useCallback(async () => {
    const requestEpoch = snapshotVaultSessionEpoch();
    const request = ++eventRequest.current;
    const isCurrent = () => isVaultSessionEpochCurrent(requestEpoch) && !lifetime.current?.signal.aborted && request === eventRequest.current;
    setEventStateKey(eventKey);
    setEventsLoading(true); setEventsError(null); setEvents(null);
    try {
      const firebaseIdToken = await getIdTokenRef.current();
      if (!isCurrent()) return;
      if (!firebaseIdToken) throw new Error("Sign in again to load Calendar.");
      const response = await GoogleCalendarService.today({ firebaseIdToken, isEffectCurrent: isCurrent, date, timeZone: zone });
      if (isCurrent()) {
        setEvents(response.events); setUnreadableCalendars(response.unreadable_calendars);
        const prior = selection.current;
        // Renewal replaces the token and advances the privacy epoch. Resume
        // the same owner's editable draft only after a fresh authorized read;
        // a prepared confirmation must always be reviewed again.
        if (prior && prior.token !== token && prior.email === status.google_email) {
          const fresh = response.events.find(event => event.id === prior.event.id && event.calendar_id === prior.event.calendar_id);
          selection.current = fresh ? { event: fresh, token, email: status.google_email } : null;
          setSelected(fresh || null); setSelectedEpoch(requestEpoch); setSelectedEmail(status.google_email); setReview(null);
          setStep(current => current === "review" ? "choice" : current);
        }
      }
    } catch (error) { if (isCurrent()) setEventsError(formatFailure(error)); }
    finally { if (isCurrent()) setEventsLoading(false); }
  }, [token, date, zone, eventKey, status.google_email]);
  useEffect(() => { void loadEvents(); }, [loadEvents, status.access_level, status.calendar_list_access, connectionRevision]);
  usePeriodicTask("calendar-workspace-events", 60_000, loadEvents, { enabled: tab === "schedule" && view === "today" && !selected });

  const checkAvailability = useCallback(async () => {
    const requestEpoch = snapshotVaultSessionEpoch();
    const request = ++availabilityRequest.current;
    const isCurrent = () => isVaultSessionEpochCurrent(requestEpoch) && !lifetime.current?.signal.aborted && request === availabilityRequest.current;
    setAvailabilityStateKey(availabilityKey);
    setAvailabilityLoading(true); setAvailability(null); setAvailabilityError(null);
    try {
      const firebaseIdToken = await getIdTokenRef.current();
      if (!isCurrent()) return;
      if (!firebaseIdToken) throw new Error("Sign in again to check availability.");
      const response = await GoogleCalendarService.availability({ firebaseIdToken, isEffectCurrent: isCurrent, date, timeZone: zone, startTime, endTime, durationMinutes: duration });
      if (isCurrent()) setAvailability(response);
    } catch (error) { if (isCurrent()) setAvailabilityError(formatFailure(error)); }
    finally { if (isCurrent()) setAvailabilityLoading(false); }
  }, [date, zone, startTime, endTime, duration, availabilityKey]);
  useEffect(() => { availabilityRequest.current++; if (view === "free" && tab === "schedule") void checkAvailability(); }, [view, tab, checkAvailability]);
  usePeriodicTask("calendar-workspace-availability", 60_000, checkAvailability, { enabled: tab === "schedule" && view === "free" && !selected });
  useEffect(() => {
    if (token) return;
    if (ownerTokenStatus === "locked") { selection.current = null; setSelected(null); setReview(null); setResult(null); setActionError(null); setStep("details"); }
  }, [token, ownerTokenStatus]);
  useEffect(() => {
    if (selection.current && selection.current.email !== status.google_email) {
      selection.current = null; setSelected(null); setReview(null); setResult(null); setActionError(null); setStep("details");
    }
  }, [status.google_email]);

  const closeDetails = () => {
    if (submittingRef.current) return;
    selection.current = null;
    setSelected(null); setReview(null); setResult(null); setActionError(null); setStep("details");
  };
  useBackLayer("/one/calendar", settingsOpen ? 1 : selected ? (step === "details" ? 1 : 2) : 0, () => {
    if (submittingRef.current) return true;
    if (settingsOpen) { setSettingsOpen(false); return true; }
    if (step === "review") { setStep("choice"); setReview(null); }
    else if (step === "choice") setStep("details");
    else closeDetails();
    return true;
  });
  const runAction = async (work: () => Promise<void>) => {
    if (submittingRef.current) return;
    const vaultEpoch = snapshotVaultSessionEpoch();
    const isCurrent = () => isVaultSessionEpochCurrent(vaultEpoch) && !lifetime.current?.signal.aborted;
    submittingRef.current = true; setSubmitting(true); setActionError(null);
    try { await work(); }
    catch (error) { if (isCurrent()) setActionError(formatFailure(error)); }
    finally { submittingRef.current = false; if (!lifetime.current?.signal.aborted) setSubmitting(false); }
  };
  const prepareReview = () => runAction(async () => {
    if (!token || !selected?.id) throw new Error("Calendar access changed. Reload this invitation.");
    const vaultEpoch = snapshotVaultSessionEpoch();
    const isCurrent = () => isVaultSessionEpochCurrent(vaultEpoch) && !lifetime.current?.signal.aborted;
    const firebaseIdToken = await getIdToken?.();
    if (!isCurrent()) return;
    if (!firebaseIdToken) throw new Error("Sign in again to review attendance changes.");
    const next = await GoogleCalendarService.reviewAttendance({ ...windowParams, firebaseIdToken, isEffectCurrent: isCurrent, eventId: selected.id, calendarId: selected.calendar_id, offerTimes, message });
    if (!isCurrent()) return;
    setReview(next); setStep("review");
  });
  const confirm = () => runAction(async () => {
    if (!token || !review) return;
    const vaultEpoch = snapshotVaultSessionEpoch();
    const isCurrent = () => isVaultSessionEpochCurrent(vaultEpoch) && !lifetime.current?.signal.aborted;
    const firebaseIdToken = await getIdToken?.();
    if (!isCurrent()) return;
    if (!firebaseIdToken) throw new Error("Sign in again to confirm attendance changes.");
    const next = await GoogleCalendarService.confirmAttendance({ firebaseIdToken, isEffectCurrent: isCurrent, vaultOwnerToken: token, reviewId: review.review_id, reviewToken: review.review_token });
    if (!isCurrent()) return;
    setResult(next); setStep("result");
    if (next.calendar === "declined") void loadEvents();
  });
  const saveSettings = () => {
    try {
      calendarDate(now, zoneInput.trim());
      if (!/^\d{2}:\d{2}$/.test(settingsStart) || !/^\d{2}:\d{2}$/.test(settingsEnd) || settingsStart >= settingsEnd) throw new Error("Availability end must be after start.");
      setZone(zoneInput.trim()); setStartTime(settingsStart); setEndTime(settingsEnd); setZoneError(""); setSettingsOpen(false);
    } catch (error) { setZoneError(error instanceof RangeError ? "Enter a valid IANA time zone, such as Asia/Kolkata." : formatFailure(error).message); }
  };
  const recovery = (error: Error, availabilityFailure = false) => (
    <div role="alert" className="space-y-2">
      <p className="font-semibold">{availabilityFailure ? "Availability could not be checked." : "Calendar could not be loaded."}</p>
      <p className="text-sm text-muted-foreground">{error.message}</p>
      {error instanceof GoogleCalendarError && error.recovery !== "retry" ? (
        <Button variant="outline" disabled={busy} onClick={() => onConnect("read", error instanceof GoogleCalendarError && error.reasonCode === "calendar_list_permission_required")}>{error.recovery === "reconnect" ? "Reconnect Calendar" : "Allow Calendar access"}</Button>
      ) : <Button variant="outline" onClick={() => void (availabilityFailure ? checkAvailability() : loadEvents())}>Try again</Button>}
    </div>
  );
  const windowControls = (prefix: string) => (
    <div className="grid grid-cols-2 gap-[var(--app-form-section-gap)] sm:grid-cols-3">
      <label className="col-span-2 space-y-[var(--app-form-field-gap)] sm:col-span-1"><span className="text-sm text-muted-foreground">Date</span><Input aria-label={`${prefix} date`} disabled={submitting || busy} type="date" value={alternativeDate} onChange={e => { if (e.target.value) setAlternativeDate(e.target.value); }} /></label>
      <label className="space-y-[var(--app-form-field-gap)]"><span className="text-sm text-muted-foreground">From</span><Input aria-label={`${prefix} window start`} disabled={submitting || busy} type="time" value={startTime} onChange={e => setStartTime(e.target.value)} /></label>
      <label className="space-y-[var(--app-form-field-gap)]"><span className="text-sm text-muted-foreground">Until</span><Input aria-label={`${prefix} window end`} disabled={submitting || busy} type="time" value={endTime} onChange={e => setEndTime(e.target.value)} /></label>
      <div className="col-span-2 sm:col-span-3"><SegmentedTabs disabled={submitting || busy} variant="filter" ariaLabel={`${prefix} duration`} value={String(duration)} options={[15, 30, 60].map(value => ({ value: String(value), label: `${value} min` }))} onValueChange={value => setDuration(Number(value) as 15 | 30 | 60)} /></div>
    </div>
  );
  const allDay = (events || []).filter(event => Boolean(event.start?.date));
  const timed = (events || []).filter(event => Boolean(event.start?.dateTime)).sort((a, b) => Date.parse(a.start!.dateTime!) - Date.parse(b.start!.dateTime!));
  const ongoing = timed.find(event => Date.parse(event.start!.dateTime!) <= now && Date.parse(event.end?.dateTime || "") > now && !event.attendees?.some(attendee => attendee.self && attendee.response_status === "declined"));
  const highlighted = ongoing || timed.find(event => Date.parse(event.start!.dateTime!) > now && !event.attendees?.some(attendee => attendee.self && attendee.response_status === "declined"));
  const openDetails = (event: CalendarEventSummary, trigger: HTMLButtonElement) => {
    if (submittingRef.current) return;
    selection.current = { event, token, email: status.google_email };
    detailTrigger.current = trigger; setSelectedEpoch(snapshotVaultSessionEpoch()); setSelectedEmail(status.google_email); setSelected(event); setStep("details"); setActionError(null);
    setAlternativeDate(date);
    setOfferTimes(false); setReview(null); setResult(null);
    setMessage("I can't attend our meeting. Please choose another time using the link below and update the invitation.");
  };
  const providerUrl = calendarProviderDayUrl(date, status.google_email);
  const openSettings = (trigger?: HTMLButtonElement) => { settingsTrigger.current = trigger || accountMenuButton.current; setZoneInput(zone); setSettingsStart(startTime); setSettingsEnd(endTime); setZoneError(""); setSettingsOpen(true); };
  const timeline = (items: CalendarEventSummary[]) => {
    // Keep chronological order and group the white rows around the highlighted
    // meeting, rather than moving the next meeting ahead of past events.
    const groups: [CalendarEventSummary, ...CalendarEventSummary[]][] = [];
    items.forEach(event => {
      const previous = groups.at(-1);
      if (event === highlighted || previous?.[0] === highlighted || !previous) groups.push([event]);
      else previous.push(event);
    });
    return <div className="space-y-0.5">{groups.map(group => <ul key={`${group[0].calendar_id}:${group[0].id}`} className={group[0] === highlighted ? undefined : scheduleStyles.eventGroup}>{group.map(event => <CalendarTimelineRow key={`${event.calendar_id}:${event.id}`} event={event} zone={zone} active={event === highlighted} ongoing={event === ongoing} now={now} onOpen={openDetails} />)}</ul>)}</div>;
  };
  const scheduleLoading = view === "today" ? eventsLoading : availabilityLoading;
  const reconnectRequired = [eventsError, availabilityError].some(error => error instanceof GoogleCalendarError && (error.recovery === "reconnect" || error.recovery === "connect"));

  return <AppPageShell width="agent" headerContentSpacing="compact" fitContent className="relative isolate" nativeTest={{ routeId: ROUTES.CALENDAR, marker: "native-route-calendar", authState: "authenticated", dataState: view === "today" ? eventsLoading ? "loading" : eventsError ? "error" : events?.length ? "loaded" : "empty-valid" : availabilityLoading ? "loading" : availabilityError ? "error" : availability ? availability.windows.length ? "loaded" : "empty-valid" : "unavailable-valid" }}>
    <div className="mx-auto w-full max-w-[820px] space-y-[var(--page-header-section-gap)]" data-calendar-workspace>
      <PageHeader title="Calendar" titleRole="agent" actionsInlineMobile description={<div className="space-y-1"><p className="break-all text-sm text-muted-foreground">{status.google_email || "Connected Google account"}</p><p className={`flex items-center gap-1.5 text-sm font-medium ${reconnectRequired ? "text-muted-foreground" : "text-[color:var(--app-success-deep)]"}`}>{reconnectRequired ? <Lock aria-hidden className="size-4" /> : <CheckCircle aria-hidden weight="fill" className="size-5 text-[color:var(--app-success)]" />}{reconnectRequired ? "Reconnect required" : "Connected"}</p></div>} actions={<>
        <a aria-label="Open Google Calendar" className="inline-flex size-[42px] items-center justify-center rounded-[var(--app-radius-sm)] border border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-compact)] focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] sm:size-12" href={providerUrl} target="_blank" rel="noopener noreferrer"><GoogleCalendarMark className="size-7" /></a>
        <DropdownMenu><DropdownMenuTrigger asChild><Button ref={accountMenuButton} aria-label="Calendar settings and actions" disabled={busy || submitting} variant="ghost" size="icon" className="size-10 rounded-[var(--app-radius-sm)] bg-[color:var(--app-segmented-track-surface)] !text-[color:var(--app-label)] sm:size-[46px]"><MoreHorizontal className="size-5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => openSettings()}>Settings</DropdownMenuItem>
          <DropdownMenuItem disabled={scheduleLoading} onSelect={() => void (view === "free" ? checkAvailability() : loadEvents())}>Refresh Calendar</DropdownMenuItem>
          <DropdownMenuItem asChild><a href={providerUrl} target="_blank" rel="noopener noreferrer">Open Google Calendar</a></DropdownMenuItem>
          <DropdownMenuItem onSelect={onDisconnect}>Disconnect Calendar</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </>} />
      {connectionNotice}
      <TopShellTabs disabled={submitting || busy} tabSet={{ id: "calendar", label: "Calendar", queryParam: null, activeValue: tab, tabs: MAIN_TABS }} onValueChange={setTab} />
      {tab !== "schedule" ? <SurfaceCard role="tabpanel" id={`top-shell-calendar-panel-${tab}`} aria-labelledby={`top-shell-calendar-tab-${tab}`} className="p-6 shadow-none"><h2 className="font-semibold">{tab === "invitations" ? "Invitations" : "Insights"}</h2><p className="mt-2 text-sm text-muted-foreground">Coming soon</p></SurfaceCard> : <div role="tabpanel" id="top-shell-calendar-panel-schedule" aria-labelledby="top-shell-calendar-tab-schedule" className="space-y-3">
        <div className="py-1"><SegmentedTabs disabled={submitting || busy} variant="filter" ariaLabel="Schedule views" options={SCHEDULE_TABS} value={view} onValueChange={setView} /></div>
        <div className="flex min-h-10 items-center justify-between gap-2 sm:min-h-[34px]">
          <label className="relative min-w-0 cursor-pointer rounded-md text-[13px] sm:text-[15px] focus-within:ring-2 focus-within:ring-[color:var(--app-accent-ring)]"><span>{calendarDayLabel(date)}</span><input aria-label="Selected date" type="date" value={date} disabled={submitting || busy} onChange={event => { if (event.target.value) setDate(event.target.value); }} className="absolute inset-0 w-full cursor-pointer opacity-0" /></label>
          <div className="flex shrink-0 items-center gap-1"><Button ref={refreshButton} size="sm" variant="outline" disabled={submitting || busy} className="h-8 rounded-full !bg-[color:var(--app-card-surface-compact)] px-3 font-normal !text-[color:var(--app-label)] shadow-none sm:h-[34px]" onClick={() => setDate(today)}>Today</Button><Button size="icon" variant="ghost" className="size-8 !text-[color:var(--app-label)]" aria-label="Previous day" disabled={submitting || busy} onClick={() => setDate(value => shiftCalendarDate(value, -1))}><ChevronLeft className="size-4" /></Button><Button size="icon" variant="ghost" className="size-8 !text-[color:var(--app-label)]" aria-label="Next day" disabled={submitting || busy} onClick={() => setDate(value => shiftCalendarDate(value, 1))}><ChevronRight className="size-4" /></Button></div>
        </div>
        {view === "today" ? <section aria-label="Today's events" className="space-y-3">
          {eventsLoading ? <SurfaceCard className="p-5 shadow-none"><p role="status" aria-live="polite">Loading events…</p></SurfaceCard> : eventsError ? <SurfaceCard className="p-5 shadow-none">{recovery(eventsError)}</SurfaceCard> : <>
            {unreadableCalendars.length ? <p role="status" className="text-xs text-muted-foreground">Event details are not shared for {unreadableCalendars.map(calendar => calendar.name || calendar.id).join(", ")}. Their busy times are included in availability checks.</p> : null}
            {events?.length === 0 ? <SurfaceCard className="p-6 shadow-none"><p>{date === today ? "No events today." : "No events on this day."}</p><p className="mt-1 text-sm text-muted-foreground">{unreadableCalendars.length ? "No events in calendars that share event details." : "Your included calendars are clear."}</p></SurfaceCard> : <>
              {allDay.length ? <div className="space-y-2"><h3 className="text-xs font-semibold text-muted-foreground">All-day events</h3>{timeline(allDay)}</div> : null}
              {timed.length ? timeline(timed) : null}
            </>}
          </>}
          <CalendarProviderShortcut date={date} email={status.google_email} />
        </section> : <section aria-label="Free time" className="space-y-2.5">
          <SurfaceCard className="space-y-3.5 p-[15px] shadow-none sm:space-y-[15px] sm:p-4">
            <div className="flex min-h-[73px] items-center gap-[15px] sm:gap-[22px]"><span aria-hidden className="flex h-16 w-[60px] shrink-0 items-center justify-center rounded-[15px] bg-[color:var(--app-card-surface-compact)] sm:h-[73px] sm:w-[74px]"><CalendarAvailabilityArt /></span><div className="min-w-0"><h2 aria-live="polite" className="text-base font-semibold leading-6 sm:text-lg">{availabilityLoading ? "Checking availability…" : availabilityError ? "Availability could not be checked" : `${availability?.full_count || 0} available slots ${date === today ? "today" : "on this day"}`}</h2><p className="mt-1 text-sm text-muted-foreground">Find time for what matters.</p></div></div>
            <SegmentedTabs className="gap-[7px] [&>button]:h-[38px] [&>button]:flex-1 [&>button[data-state=inactive]]:bg-[color:var(--app-card-surface-data)] sm:[&>button]:h-9" disabled={submitting || busy} variant="filter" ariaLabel="Availability duration" value={String(duration)} options={[15, 30, 60].map(value => ({ value: String(value), label: `${value} min` }))} onValueChange={value => setDuration(Number(value) as 15 | 30 | 60)} />
            <button type="button" onClick={event => openSettings(event.currentTarget)} className="text-left text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]">{startTime} – {endTime} · {zone}</button>
          </SurfaceCard>
          {availabilityError ? <SurfaceCard className="p-4 shadow-none">{recovery(availabilityError, true)}</SurfaceCard> : availability && !availabilityLoading ? <div aria-live="polite" className="space-y-3">
            {availability.windows.length ? <ul className="space-y-2">{availability.windows.map(window => <li key={window.start_at}><SurfaceCard className="shadow-none"><div className="flex min-h-[68px] items-center gap-3 px-4 py-2.5 sm:min-h-[65px]"><div className="min-w-0 flex-1"><p className="text-[13px] font-medium leading-[21px] sm:text-sm">{timeRangeLabel(window.start_at, window.end_at, zone)}</p><p className="mt-1 text-xs text-muted-foreground">{durationLabel(window.duration_minutes)}</p></div><Button aria-label={`Ask One about ${timeRangeLabel(window.start_at, window.end_at, zone)}`} variant="ghost" size="icon" className="size-10 shrink-0 rounded-full bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent)]" onClick={() => onChat(`Help me find time for a ${duration}-minute meeting on ${date} during ${timeRangeLabel(window.start_at, window.end_at, zone)} (${zone}). Available window (UTC): ${window.start_at} to ${window.end_at}. Review the details with me before taking action.`)}><Plus className="size-5" /></Button></div></SurfaceCard></li>)}</ul> : <SurfaceCard className="p-4 shadow-none"><p className="text-sm">No free slots in this window.</p></SurfaceCard>}
            {availability.full_count > 3 ? <p className="text-xs text-muted-foreground">Showing 3 of {availability.full_count} available windows.</p> : null}
            <p className="text-xs text-muted-foreground">Availability can change. These times aren't reserved.</p>
          </div> : null}
          <CalendarProviderShortcut date={date} email={status.google_email} availability />
          <SurfaceCard className="shadow-none bg-[color:var(--app-card-surface-surface)]"><button type="button" onClick={() => onChat(`Help me find a different time on ${date} in ${zone} for a ${duration}-minute meeting. My availability hours are ${startTime} to ${endTime}.`)} className="flex min-h-[90px] w-full items-start gap-[14px] px-3 py-[14px] text-left sm:gap-[17px] sm:px-4 sm:py-[13px] focus-visible:rounded-[var(--app-card-radius-standard)] focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"><CalendarHelperIcon /><span><span className="block text-sm font-medium">Need a different time?</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">Just ask One to find time, schedule a meeting or reschedule for you.</span></span></button></SurfaceCard>
        </section>}
        <div className="flex flex-col items-center gap-2 pt-1"><AskOneButton showIcon={false} disabled={busy || submitting} onClick={() => onChat()} className="!h-[50px] !w-full rounded-full !text-[15px] !font-medium sm:!text-lg !bg-[color:var(--app-accent)] !text-[color:var(--app-accent-fg)]">Try Calendar Agent with One</AskOneButton><button type="button" disabled={busy || submitting} className="min-h-11 px-3 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]" onClick={onDisconnect}>Disconnect Calendar</button></div>
      </div>}
    </div>
    <Dialog modal open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent onCloseAutoFocus={event => { if (settingsTrigger.current?.isConnected) { event.preventDefault(); settingsTrigger.current.focus(); } }}><DialogHeader><DialogTitle>Calendar settings</DialogTitle><DialogDescription>Time zone and availability hours for this session.</DialogDescription></DialogHeader>
        <label className="space-y-2"><span className="text-sm">Time zone</span><Input aria-label="Time zone" value={zoneInput} onChange={event => setZoneInput(event.target.value)} /></label>
        <fieldset className="grid grid-cols-2 gap-3"><legend className="mb-2 text-sm">Availability hours</legend><label className="space-y-2"><span className="text-sm text-muted-foreground">From</span><Input aria-label="Availability window start" type="time" value={settingsStart} onChange={event => setSettingsStart(event.target.value)} /></label><label className="space-y-2"><span className="text-sm text-muted-foreground">Until</span><Input aria-label="Availability window end" type="time" value={settingsEnd} onChange={event => setSettingsEnd(event.target.value)} /></label></fieldset>
        {zoneError ? <p role="alert" className="text-sm text-destructive">{zoneError}</p> : null}
        <Button onClick={saveSettings}>Save settings</Button>
      </DialogContent>
    </Dialog>
    <Dialog modal open={Boolean(selected)} onOpenChange={open => { if (!open) closeDetails(); }}>
      <DialogContent className="max-h-[80dvh] overflow-y-auto" onCloseAutoFocus={event => { event.preventDefault(); if (detailTrigger.current?.isConnected) detailTrigger.current.focus(); else refreshButton.current?.focus(); }} onEscapeKeyDown={event => { if (submittingRef.current) event.preventDefault(); }} onInteractOutside={event => { if (submittingRef.current) event.preventDefault(); }}>
        {selected ? <>
        <DialogHeader><DialogTitle>{step === "review" ? "Review your response" : step === "result" ? "Your response" : selected?.title}</DialogTitle><DialogDescription>{selected ? `${eventTime(selected, zone)} · ${zone}` : "Invitation details"}</DialogDescription></DialogHeader>
        {connectionNotice}
        {step === "details" && selected ? <div className="space-y-4">
          {selected.description ? <p className="whitespace-pre-wrap break-words text-sm">{selected.description}</p> : null}
          {selected.location ? <p className="text-sm">{selected.location}</p> : null}
          {selected.organizer?.email ? <p className="break-all text-sm text-muted-foreground">Organizer: {selected.organizer.email}</p> : null}
          {safeMeetingUrl(selected.conference_url) ? <a className="inline-flex min-h-11 items-center text-[color:var(--app-accent)]" href={safeMeetingUrl(selected.conference_url)!} target="_blank" rel="noopener noreferrer">Join meeting</a> : null}
          {selected.can_decline ? <Button variant="outline" onClick={() => { setStep("choice"); setResult(null); setReview(null); }}>Can't attend</Button> : <p className="text-sm text-muted-foreground">Attendance changes are available on invitations to your connected account.</p>}
        </div> : step === "choice" ? <div className="space-y-4">
          <fieldset disabled={submitting || busy} className="space-y-2"><legend className="text-sm font-semibold">Can't attend</legend><label className="flex min-h-11 items-center gap-3"><input type="radio" name="attendance" checked={!offerTimes} onChange={() => setOfferTimes(false)} />Decline only</label><label className="flex min-h-11 items-center gap-3"><input type="radio" name="attendance" checked={offerTimes} onChange={() => setOfferTimes(true)} />Decline &amp; offer another time</label></fieldset>
          <p className="text-sm text-muted-foreground">Only your attendance response changes. The organizer keeps the meeting.</p>
          {offerTimes ? <><label className="block space-y-[var(--app-form-field-gap)]"><span className="text-sm">Message to organizer</span><Textarea disabled={submitting || busy} aria-label="Message to organizer" rows={4} value={message} onChange={event => setMessage(event.target.value)} /></label>{windowControls("Alternative")}<p className="text-xs text-muted-foreground">{zone}. A recipient-accessible link to checked alternatives will be included for review. The organizer chooses a time and updates the invitation.</p></> : null}
          {status.access_level !== "manage" ? <Button disabled={busy} onClick={() => onConnect("manage")}>Allow attendance changes</Button> : <Button disabled={submitting || busy} onClick={() => void prepareReview()}>{submitting ? "Preparing review…" : "Review"}</Button>}
        </div> : step === "review" && review ? <div className="space-y-4">
          <p>Decline your attendance at <strong>{review.title}</strong>.</p>
          {review.message ? <><p className="break-all text-sm">From: {review.sender_label}<br />To: {review.recipient}</p><p className="text-sm font-semibold">{review.subject}</p><p className="whitespace-pre-wrap break-words text-sm">{review.rescheduling_link ? review.message.replace(review.rescheduling_link, "").trim() : review.message}</p>{review.rescheduling_link ? <a href={review.rescheduling_link} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm text-[color:var(--app-accent)]">Review recipient rescheduling link</a> : null}<p className="text-xs text-muted-foreground">Link expires in 3 days. The organizer can view the offered times without signing in to One and reply with a choice.</p></> : <p className="text-sm text-muted-foreground">Google Calendar will record your declined attendance.</p>}
          <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={submitting} onClick={() => { setStep("choice"); setReview(null); }}>Edit</Button><Button disabled={submitting || busy} onClick={() => void confirm()}>{submitting ? "Confirming…" : "Confirm"}</Button></div>
        </div> : result ? <div role="status" className="space-y-3"><p>{result.calendar === "declined" ? "Your attendance was declined." : result.calendar === "unknown" ? "Calendar response could not be confirmed. Check the invitation before trying again." : "Your attendance could not be declined."}</p>{result.calendar_error ? <p className="text-sm text-muted-foreground">{result.calendar_error}</p> : null}{result.email === "sent" ? <p>The organizer's email was sent.</p> : result.email === "failed" || result.email === "unknown" ? <p className="text-sm text-destructive">{result.email_error || "Organizer email delivery could not be confirmed. Check Sent Mail before trying again."}</p> : offerTimes ? <p className="text-sm text-muted-foreground">The organizer's email was not sent.</p> : null}<Button variant="outline" onClick={closeDetails}>Done</Button></div> : null}
        {actionError ? <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{actionError.message}</p>{actionError instanceof GoogleCalendarError && actionError.reasonCode?.startsWith("GMAIL") && onMailConnect ? <Button disabled={submitting} variant="outline" onClick={() => void runAction(onMailConnect)}>Enable Mail sending</Button> : actionError instanceof GoogleCalendarError && actionError.recovery === "permission" ? <Button disabled={busy} variant="outline" onClick={() => onConnect(actionError.reasonCode === "calendar_list_permission_required" ? "read" : "manage", actionError.reasonCode === "calendar_list_permission_required")}>Allow Calendar access</Button> : null}</div> : null}
        </> : <DialogHeader><DialogTitle>Calendar</DialogTitle><DialogDescription>Calendar access is being restored.</DialogDescription></DialogHeader>}
      </DialogContent>
    </Dialog>
  </AppPageShell>;
}
