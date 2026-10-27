"use client";

import { CalendarLoading } from "./calendar-loading";
import { CalendarAccountBoard } from "./calendar-account-board";
import { CalendarDateNavigation } from "./calendar-date-navigation";
import { CalendarInsights } from "./calendar-insights";
import { CalendarInvitations } from "./calendar-invitations";
import type { CalendarInvitationHandoff, CalendarAttendanceHandoff } from "@/lib/calendar/calendar-invitation-handoff";
import { notifyCalendarChanged } from "@/lib/calendar/calendar-refresh";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle, Lock, MoreHorizontal, Plus } from "@/components/icons";
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
import { isCalendarEventEnded } from "@/lib/calendar/calendar-event-status";
export { safeMeetingUrl } from "@/lib/calendar/calendar-url";
import { GoogleCalendarService, GoogleCalendarError, type CalendarEventSummary, type CalendarSource, type CalendarAvailability, type CalendarAttendanceReview, type CalendarAttendanceResult, type GoogleCalendarStatus } from "@/lib/services/google-calendar-service";
import { CalendarAvailabilityArt, CalendarHelperIcon, CalendarTimelineRow, calendarResponse, GoogleCalendarMark, calendarDate, availabilityTimeRangeLabel, calendarProviderDayUrl, MAIN_TABS, SCHEDULE_TABS, durationLabel, eventTime, timeRangeLabel } from "./calendar-schedule-presentation";
export { calendarDate } from "./calendar-schedule-presentation";
import { earliestCalendarSlot, type CalendarSlotHandoff } from "@/lib/calendar/calendar-slot-handoff";
import { calendarRefreshKey } from "@/lib/calendar/calendar-refresh";
import { CacheService } from "@/lib/services/cache-service";
import scheduleStyles from "./calendar-schedule.module.css";
import presentationStyles from "./calendar-presentation.module.css";
import { CalendarCompactAction } from "./calendar-compact-action";

function formatFailure(error: unknown): Error {
  return error instanceof Error ? error : new Error("Calendar could not be checked.");
}

type Props = {
  userId: string;
  status: GoogleCalendarStatus;
  busy: boolean;
  onConnect: (access: "read" | "manage", includeCalendarList?: boolean) => void;
  onAddAccount?: () => void;
  onReconnectAccount?: (accountId: string) => void;
  onDisconnectAccount?: (accountId: string) => void;
  onChat: (prompt?: string, slot?: CalendarSlotHandoff, invitation?: CalendarInvitationHandoff, attendance?: CalendarAttendanceHandoff) => void;
  onDisconnect: () => void;
  onMailConnect?: () => Promise<void>;
  connectionNotice?: ReactNode;
  getIdToken: () => Promise<string>;
  connectionRevision?: number;
};

/** Schedule uses signed-in Google consent; attendance retains vault-owner authority. */
export function CalendarConnectedWorkspace(props: Props) {
  const { vaultOwnerToken, ownerTokenStatus } = useVault();
  if (props.status.accounts?.length && props.onAddAccount && props.onDisconnectAccount && props.onReconnectAccount) {
    return <CalendarAccountBoard key={props.userId} {...props} onAddAccount={props.onAddAccount}
      onReconnectAccount={props.onReconnectAccount}
      onDisconnectAccount={props.onDisconnectAccount} token={vaultOwnerToken} />;
  }
  return <ConnectedSchedule key={props.userId} {...props} token={vaultOwnerToken} ownerTokenStatus={ownerTokenStatus} />;
}

function ConnectedSchedule({ userId, status, busy, onConnect, onChat, onDisconnect, onMailConnect, connectionNotice, getIdToken, connectionRevision, token, ownerTokenStatus }: Props & { token: string | null; ownerTokenStatus: "locked" | "valid" | "renewing" | "unavailable" }) {
  const getIdTokenRef = useRef(getIdToken);
  getIdTokenRef.current = getIdToken;
  const [tab, setTab] = useState("schedule");
  const [view, setView] = useState("today");
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [zonePreference, setZonePreference] = useState(() => ({ account: status.google_email, value: deviceZone, explicit: false }));
  // Use the same device timezone as One chat. Google calendar metadata describes
  // the provider's defaults, not the owner's current display preference.
  const zone = zonePreference.account === status.google_email ? zonePreference.value : deviceZone;
  const [zoneInput, setZoneInput] = useState(zone);
  const [zoneError, setZoneError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsStart, setSettingsStart] = useState("09:00");
  const [settingsEnd, setSettingsEnd] = useState("17:00");
  const [entryTime] = useState(() => Date.now());
  const now = Math.max(entryTime, useCoarseClock(60_000));
  const nowRef = useRef(now);
  nowRef.current = now;
  const today = calendarDate(now, zone);
  const [date, setDate] = useState(today);
  const [alternativeDate, setAlternativeDate] = useState(today);
  useEffect(() => {
    if (zonePreference.account === status.google_email) return;
    const previousToday = calendarDate(nowRef.current, zonePreference.value);
    const nextToday = calendarDate(nowRef.current, deviceZone);
    setDate(value => value === previousToday ? nextToday : value);
    setAlternativeDate(value => value === previousToday ? nextToday : value);
    setZonePreference({ account: status.google_email, value: deviceZone, explicit: false });
  }, [status.google_email, deviceZone, zonePreference]);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [duration, setDuration] = useState<15 | 30 | 60>(15);
  const epoch = snapshotVaultSessionEpoch();
  const calendarAccountKey = `${status.google_email}:${connectionRevision || 0}`;
  const [sourceCatalog, setSourceCatalog] = useState<{ key: string; calendars: CalendarSource[] }>({ key: "", calendars: [] });
  const [appliedSelection, setAppliedSelection] = useState<{ key: string; overrides: Record<string, boolean> }>({ key: "", overrides: {} });
  const [selectionDraft, setSelectionDraft] = useState<{ key: string; overrides: Record<string, boolean> }>({ key: "", overrides: {} });
  const [pendingExclusion, setPendingExclusion] = useState<CalendarSource | null>(null);
  const settingsActive = settingsOpen && selectionDraft.key === calendarAccountKey;
  const calendarOptions = sourceCatalog.key === calendarAccountKey ? sourceCatalog.calendars : [];
  const selectionJson = JSON.stringify(appliedSelection.key === calendarAccountKey ? appliedSelection.overrides : {});
  const rememberCalendars = useCallback((calendars: CalendarSource[]) => {
    setSourceCatalog({ key: calendarAccountKey, calendars });
  }, [calendarAccountKey]);
  const [calendarRevision, setCalendarRevision] = useState(0);
  useEffect(() => CacheService.getInstance().subscribe(event => {
    if (event.type === "set" && event.key === calendarRefreshKey(userId)) setCalendarRevision(value => value + 1);
  }), [userId]);
  const eventKey = `${calendarRevision}:${date}:${zone}:${epoch}:${status.google_email}:${connectionRevision || 0}:${status.access_level}:${status.calendar_list_access}`;
  const availabilityKey = `full-day-v1:${calendarRevision}:${selectionJson}:${date}:${zone}:${duration}:${epoch}:${status.google_email}:${connectionRevision || 0}:${status.access_level}:${status.calendar_list_access}`;
  const currentReadKeys = useRef({ events: eventKey, availability: availabilityKey });
  currentReadKeys.current = { events: eventKey, availability: availabilityKey };
  const [eventStateKey, setEventStateKey] = useState("");
  const [availabilityStateKey, setAvailabilityStateKey] = useState("");
  const [storedEvents, setEvents] = useState<CalendarEventSummary[] | null>(null);
  const [unreadableCalendars, setUnreadableCalendars] = useState<CalendarSource[]>([]);
  const [storedEventsError, setEventsError] = useState<Error | null>(null);
  const [storedEventsLoading, setEventsLoading] = useState(false);
  const availabilityPreview = useRef<{ key: string; value: CalendarAvailability } | null>(null);
  if (availabilityPreview.current?.key !== availabilityKey) availabilityPreview.current = null;
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
  if (availabilityError) availabilityPreview.current = null;
  const refreshingAvailability = availabilityLoading && !availabilityError ? availabilityPreview.current?.value : null;
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
  const lastReadStarted = useRef({ events: 0, availability: 0 });
  const loadedEventKey = useRef<string | null>(null);
  const eventFlight = useRef<{ key: string; controller: AbortController } | null>(null);
  const availabilityFlight = useRef<{ key: string; controller: AbortController } | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => { controller.abort(); eventFlight.current?.controller.abort(); availabilityFlight.current?.controller.abort(); };
  }, []);
  const windowParams = { vaultOwnerToken: token || "", date: alternativeDate, timeZone: zone, startTime, endTime, durationMinutes: duration };

  const loadEvents = useCallback(async () => {
    if (currentReadKeys.current.events !== eventKey) return;
    if (eventFlight.current?.key === eventKey && !eventFlight.current.controller.signal.aborted) return;
    eventFlight.current?.controller.abort();
    if (loadedEventKey.current !== eventKey) setEvents(null);
    const controller = new AbortController();
    eventFlight.current = { key: eventKey, controller };
    lastReadStarted.current.events = Date.now();
    const requestEpoch = snapshotVaultSessionEpoch();
    const request = ++eventRequest.current;
    const isCurrent = () => currentReadKeys.current.events === eventKey && !controller.signal.aborted && isVaultSessionEpochCurrent(requestEpoch) && !lifetime.current?.signal.aborted && request === eventRequest.current;
    setEventStateKey(eventKey);
    setEventsLoading(true); setEventsError(null);

    try {
      const firebaseIdToken = await getIdTokenRef.current();
      if (!isCurrent()) return;
      if (!firebaseIdToken) throw new Error("Sign in again to load Calendar.");
      const response = await GoogleCalendarService.today({ signal: controller.signal, firebaseIdToken, isEffectCurrent: isCurrent, date, timeZone: zone });
      if (isCurrent()) {
        rememberCalendars(response.calendar_options || response.calendars);
        loadedEventKey.current = eventKey; setEvents(response.events); setUnreadableCalendars(response.unreadable_calendars);
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
    } catch (error) {
      if (isCurrent()) {
        if (error instanceof GoogleCalendarError && [401, 403, 409].includes(error.status)) {
          loadedEventKey.current = null; setEvents(null); setUnreadableCalendars([]);
        }
        setEventsError(formatFailure(error));
      }
    }
    finally { if (isCurrent()) setEventsLoading(false); if (eventFlight.current?.controller === controller) eventFlight.current = null; }
  }, [token, date, zone, eventKey, status.google_email, rememberCalendars]);
  useEffect(() => { if (tab === "schedule" && view === "today") void loadEvents(); return () => { eventFlight.current?.controller.abort(); }; }, [loadEvents, tab, view]);
  usePeriodicTask("calendar-workspace-events", 30_000, () => Date.now() - lastReadStarted.current.events >= 3000 ? loadEvents() : undefined, { enabled: tab === "schedule" && view === "today" && !selected });

  const checkAvailability = useCallback(async () => {
    if (currentReadKeys.current.availability !== availabilityKey) return;
    if (availabilityFlight.current?.key === availabilityKey && !availabilityFlight.current.controller.signal.aborted) return;
    availabilityFlight.current?.controller.abort();
    const controller = new AbortController();
    availabilityFlight.current = { key: availabilityKey, controller };
    lastReadStarted.current.availability = Date.now();
    const requestEpoch = snapshotVaultSessionEpoch();
    const request = ++availabilityRequest.current;
    const ownsRequest = () => currentReadKeys.current.availability === availabilityKey && !lifetime.current?.signal.aborted && request === availabilityRequest.current;
    const isCurrent = () => !controller.signal.aborted && isVaultSessionEpochCurrent(requestEpoch) && ownsRequest();
    setAvailabilityStateKey(availabilityKey);
    setAvailabilityLoading(true); setAvailability(null); setAvailabilityError(null);
    const failOffline = () => {
      controller.abort();
      if (ownsRequest()) {
        setAvailabilityLoading(false);
        setAvailabilityError(new GoogleCalendarError("You're offline. Connect to the internet to check availability.", "calendar_offline", 0));
      }
    };
    // Also bound token acquisition; late results cannot replace timeout/offline.
    const timeout = setTimeout(() => {
      controller.abort();
      if (ownsRequest()) {
        setAvailabilityLoading(false);
        setAvailabilityError(new GoogleCalendarError("The availability check timed out. Try again.", "calendar_timeout", 504));
      }
    }, 45_000);
    controller.signal.addEventListener("abort", () => { clearTimeout(timeout); window.removeEventListener("offline", failOffline); }, { once: true });
    window.addEventListener("offline", failOffline);
    try {
      if (!navigator.onLine) { failOffline(); return; }
      const firebaseIdToken = await getIdTokenRef.current();
      if (!isCurrent()) return;
      if (!firebaseIdToken) throw new Error("Sign in again to check availability.");
      const response = await GoogleCalendarService.availability({ signal: controller.signal, firebaseIdToken, isEffectCurrent: isCurrent, date, timeZone: zone, startTime: "00:00", endTime: "24:00", durationMinutes: duration, calendarOverrides: JSON.parse(selectionJson) });
      if (isCurrent()) { const options = response.calendar_options || response.calendars; rememberCalendars(options); availabilityPreview.current = { key: availabilityKey, value: response }; setAvailability(response); }
    } catch (error) { if (isCurrent()) { if (!navigator.onLine) failOffline(); else { if (error instanceof GoogleCalendarError && error.calendarOptions) rememberCalendars(error.calendarOptions); setAvailabilityError(formatFailure(error)); } } }
    finally { clearTimeout(timeout); window.removeEventListener("offline", failOffline); if (ownsRequest()) setAvailabilityLoading(false); if (availabilityFlight.current?.controller === controller) availabilityFlight.current = null; }
  }, [date, zone, duration, availabilityKey, selectionJson, rememberCalendars]);
  useEffect(() => { if (view === "free" && tab === "schedule") void checkAvailability(); return () => { availabilityFlight.current?.controller.abort(); }; }, [view, tab, checkAvailability]);
  usePeriodicTask("calendar-workspace-availability", 30_000, () => Date.now() - lastReadStarted.current.availability >= 3000 ? checkAvailability() : undefined, { enabled: tab === "schedule" && view === "free" && !selected && Boolean(availability) && !availabilityError });
  useEffect(() => {
    let lastResume = 0;
    const resume = (event: Event) => {
      if (view === "free" && (!navigator.onLine || (availabilityError && (event.type !== "online" || !(availabilityError instanceof GoogleCalendarError) || availabilityError.reasonCode !== "calendar_offline")))) return;
      if (document.visibilityState !== "visible" || tab !== "schedule" || selected || Date.now() - lastResume < 3000) return;
      if (!(view === "free" && event.type === "online" && availabilityError) && Date.now() - lastReadStarted.current[view === "today" ? "events" : "availability"] < 3000) return;
      lastResume = Date.now();
      void (view === "today" ? loadEvents() : checkAvailability());
    };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [tab, view, selected, loadEvents, checkAvailability, availabilityError]);
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
  useBackLayer("/one/calendar", settingsActive ? pendingExclusion ? 2 : 1 : selected ? (step === "details" ? 1 : 2) : 0, () => {
    if (submittingRef.current) return true;
    if (settingsActive) { if (pendingExclusion) setPendingExclusion(null); else setSettingsOpen(false); return true; }
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
    if (next.calendar === "declined") { notifyCalendarChanged(userId); void loadEvents(); }
  });
  const saveSettings = () => {
    try {
      calendarDate(now, zoneInput.trim());
      if (!/^\d{2}:\d{2}$/.test(settingsStart) || !/^\d{2}:\d{2}$/.test(settingsEnd) || settingsStart >= settingsEnd) throw new Error("Availability end must be after start.");
      if (selectionDraft.key !== calendarAccountKey) throw new Error("Calendar account changed. Reopen settings.");
      if (calendarOptions.length && !calendarOptions.some(calendar => selectionDraft.overrides[calendar.id] ?? calendar.availability_default_included !== false)) throw new Error("Choose at least one calendar for availability.");
      // A fresh inventory may remove an unsubscribed calendar. Retire its stale
      // override only when the person explicitly reviews and saves settings.
      const overrides = Object.fromEntries(Object.entries(selectionDraft.overrides).filter(([id]) => calendarOptions.some(calendar => calendar.id === id)));
      setAppliedSelection({ key: calendarAccountKey, overrides });
      const preference = { account: status.google_email, value: zoneInput.trim(), explicit: true };
      setZonePreference(preference); setStartTime(settingsStart); setEndTime(settingsEnd); setZoneError(""); setSettingsOpen(false);
    } catch (error) { setZoneError(error instanceof RangeError ? "Enter a valid IANA time zone, such as Asia/Kolkata." : formatFailure(error).message); }
  };
  const recovery = (error: Error, availabilityFailure = false) => (
    <div role="alert" className="space-y-2">
      <p className="font-semibold">{availabilityFailure ? "Availability could not be checked." : "Calendar could not be loaded."}</p>
      <p className="text-sm text-muted-foreground">{availabilityFailure && error instanceof GoogleCalendarError && error.reasonCode === "calendar_invalid_response" ? "Calendar information was incomplete or invalid. Try again." : error.message}</p>
      {error instanceof GoogleCalendarError && error.recovery !== "retry" ? (
        <CalendarCompactAction disabled={busy} onClick={() => onConnect("read", error instanceof GoogleCalendarError && error.reasonCode === "calendar_list_permission_required")}>{error.recovery === "reconnect" ? "Reconnect Calendar" : "Allow Calendar access"}</CalendarCompactAction>
      ) : availabilityFailure ? <div className="flex flex-wrap gap-2"><CalendarCompactAction disabled={availabilityLoading} onClick={() => void checkAvailability()}>Retry</CalendarCompactAction></div> : <p className="text-sm text-muted-foreground" role="status">Checking again automatically when connected.</p>}
    </div>
  );
  const windowControls = (prefix: string) => (
    <div className="grid grid-cols-2 gap-[var(--app-form-section-gap)] sm:grid-cols-3">
      <label className="col-span-2 space-y-[var(--app-form-field-gap)] sm:col-span-1"><span className="text-sm font-semibold text-muted-foreground">Date</span><Input aria-label={`${prefix} date`} disabled={submitting || busy} type="date" value={alternativeDate} onChange={e => { if (e.target.value) setAlternativeDate(e.target.value); }} /></label>
      <label className="space-y-[var(--app-form-field-gap)]"><span className="text-sm font-semibold text-muted-foreground">From</span><Input aria-label={`${prefix} window start`} disabled={submitting || busy} type="time" value={startTime} onChange={e => setStartTime(e.target.value)} /></label>
      <label className="space-y-[var(--app-form-field-gap)]"><span className="text-sm font-semibold text-muted-foreground">Until</span><Input aria-label={`${prefix} window end`} disabled={submitting || busy} type="time" value={endTime} onChange={e => setEndTime(e.target.value)} /></label>
      <div className="col-span-2 sm:col-span-3"><SegmentedTabs disabled={submitting || busy} variant="filter" ariaLabel={`${prefix} duration`} value={String(duration)} options={[15, 30, 60].map(value => ({ value: String(value), label: `${value} min` }))} onValueChange={value => setDuration(Number(value) as 15 | 30 | 60)} /></div>
    </div>
  );
  const allDay = (events || []).filter(event => Boolean(event.start?.date));
  const timed = (events || []).filter(event => Boolean(event.start?.dateTime)).sort((a, b) => Date.parse(a.start!.dateTime!) - Date.parse(b.start!.dateTime!));
  const ongoing = timed.find(event => Date.parse(event.start!.dateTime!) <= now && Date.parse(event.end?.dateTime || "") > now && calendarResponse(event, status.google_email) !== "declined");
  const highlighted = ongoing || timed.find(event => Date.parse(event.start!.dateTime!) > now && calendarResponse(event, status.google_email) !== "declined");
  const openDetails = (event: CalendarEventSummary, trigger: HTMLButtonElement) => {
    if (submittingRef.current) return;
    selection.current = { event, token, email: status.google_email };
    detailTrigger.current = trigger; setSelectedEpoch(snapshotVaultSessionEpoch()); setSelectedEmail(status.google_email); setSelected(event); setStep("details"); setActionError(null);
    setAlternativeDate(date);
    setOfferTimes(false); setReview(null); setResult(null);
    setMessage("I can't attend our meeting. Please choose another time using the link below and update the invitation.");
  };
  const providerUrl = calendarProviderDayUrl(date, status.google_email);
  const openSettings = (trigger?: HTMLButtonElement) => { settingsTrigger.current = trigger || accountMenuButton.current; setZoneInput(zone); setSettingsStart(startTime); setSettingsEnd(endTime); setZoneError(""); setSelectionDraft({ key: calendarAccountKey, overrides: JSON.parse(selectionJson) }); setPendingExclusion(null); setSettingsOpen(true); };
  const timeline = (items: CalendarEventSummary[]) => {
    // Keep chronological order and group the white rows around the highlighted
    // meeting, rather than moving the next meeting ahead of past events.
    const groups: [CalendarEventSummary, ...CalendarEventSummary[]][] = [];
    items.forEach(event => {
      const previous = groups.at(-1);
      if (event === highlighted || previous?.[0] === highlighted || !previous) groups.push([event]);
      else previous.push(event);
    });
    return <div className="space-y-0.5">{groups.map(group => <ul key={`${group[0].calendar_id}:${group[0].id}`} className={group[0] === highlighted ? undefined : scheduleStyles.eventGroup}>{group.map(event => <CalendarTimelineRow key={`${event.calendar_id}:${event.id}`} event={event} accountEmail={status.google_email} zone={zone} active={event === highlighted} ongoing={event === ongoing} now={now} onOpen={openDetails} />)}</ul>)}</div>;
  };
  const scheduleLoading = view === "today" ? eventsLoading : availabilityLoading;
  const reconnectRequired = [eventsError, availabilityError].some(error => error instanceof GoogleCalendarError && (error.recovery === "reconnect" || error.recovery === "connect"));

  const calendarFooter = <div className="mx-auto flex w-full max-w-[420px] flex-col items-center gap-2 pt-4"><AskOneButton showIcon={false} disabled={busy || submitting} onClick={() => onChat()} className="!h-[50px] !w-full rounded-full !text-[15px] sm:!text-lg !bg-[color:var(--app-accent)] !text-[color:var(--app-accent-fg)]">Try Calendar Agent with One</AskOneButton><button type="button" disabled={busy || submitting} className={`${presentationStyles.utility} w-full px-3 text-destructive hover:text-destructive/80 focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]`} onClick={onDisconnect}>Disconnect Calendar</button></div>;

  return <AppPageShell width="agent" headerContentSpacing="compact" fitContent className="relative isolate" nativeTest={{ routeId: ROUTES.CALENDAR, marker: "native-route-calendar", authState: "authenticated", dataState: view === "today" ? eventsLoading ? "loading" : eventsError ? "error" : events?.length ? "loaded" : "empty-valid" : availabilityLoading ? "loading" : availabilityError ? "error" : availability ? availability.windows.length ? "loaded" : "empty-valid" : "unavailable-valid" }}>
    <div className={`${presentationStyles.workspace} mx-auto w-full space-y-[var(--page-header-section-gap)]`} data-calendar-workspace data-calendar-presentation>
      <PageHeader title="Calendar" titleRole="agent" titleVisuallyHidden actionsInlineMobile description={<div className="space-y-1"><p className={`${presentationStyles.support} break-all text-muted-foreground`}>{status.google_email || "Connected Google account"}</p><p className={`flex items-center gap-1.5 ${presentationStyles.status} ${reconnectRequired ? "text-muted-foreground" : "text-[color:var(--app-success-deep)]"}`}>{reconnectRequired ? <Lock aria-hidden className="size-4" /> : <CheckCircle aria-hidden weight="fill" className="size-5 text-[color:var(--app-success)]" />}{reconnectRequired ? "Reconnect required" : "Connected"}</p></div>} actions={<>
        <a aria-label="Open Google Calendar" className="inline-flex size-11 items-center justify-center rounded-[var(--app-radius-sm)] border border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-compact)] focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] sm:size-12" href={providerUrl} target="_blank" rel="noopener noreferrer"><GoogleCalendarMark className="size-7" /></a>
        <DropdownMenu><DropdownMenuTrigger asChild><Button ref={accountMenuButton} aria-label="Calendar settings and actions" disabled={busy || submitting} variant="ghost" size="icon" className="size-11 rounded-[var(--app-radius-sm)] bg-[color:var(--app-segmented-track-surface)] !text-[color:var(--app-label)] sm:size-[46px]"><MoreHorizontal className="size-5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => openSettings()}>Settings</DropdownMenuItem>
          <DropdownMenuItem disabled={scheduleLoading} onSelect={() => void (view === "free" ? checkAvailability() : loadEvents())}>Refresh Calendar</DropdownMenuItem>
          <DropdownMenuItem asChild><a href={providerUrl} target="_blank" rel="noopener noreferrer">Open Google Calendar</a></DropdownMenuItem>
          <DropdownMenuItem onSelect={onDisconnect}>Disconnect Calendar</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </>} />
      {connectionNotice}
      <p className="text-xs text-muted-foreground">Times shown in {zone}</p>
      <TopShellTabs disabled={submitting || busy} tabSet={{ id: "calendar", label: "Calendar", queryParam: null, activeValue: tab, tabs: MAIN_TABS }} onValueChange={setTab} />
      {tab === "invitations" ? <div role="tabpanel" id="top-shell-calendar-panel-invitations" aria-labelledby="top-shell-calendar-tab-invitations"><CalendarInvitations workspaceLayout connectedProfiles userId={userId} accountEmail={status.google_email} accountPhotoUrl={status.accounts?.find(account => account.account_id === "default")?.profile_photo_url} zone={zone} getIdToken={getIdToken} busy={busy} connectionRevision={connectionRevision} onConnect={onConnect} onMailConnect={onMailConnect} onBusyChange={setSubmitting} /></div> : tab !== "schedule" ? <div role="tabpanel" id="top-shell-calendar-panel-insights" aria-labelledby="top-shell-calendar-tab-insights"><CalendarInsights key={`${userId}:${calendarAccountKey}:${epoch}:${today}:${zone}`} userId={userId} accountKey={calendarAccountKey} date={today} zone={zone} getIdToken={getIdToken} vaultOwnerToken={token} /></div> : <div role="tabpanel" id="top-shell-calendar-panel-schedule" className="space-y-3">
        <div className="py-1"><SegmentedTabs disabled={submitting || busy} variant="filter" ariaLabel="Schedule views" options={SCHEDULE_TABS} value={view} onValueChange={setView} /></div>
        <CalendarDateNavigation date={date} today={today} disabled={submitting || busy} onChange={setDate} todayRef={refreshButton} />
        {view === "today" ? <section aria-label="Today's events" aria-busy={eventsLoading} className="space-y-3">
          {eventsLoading && !events ? <CalendarLoading label="Events loading" /> : eventsError && !events ? <SurfaceCard className="p-5 shadow-none">{recovery(eventsError)}</SurfaceCard> : <>
            {eventsError && events ? <SurfaceCard className="p-4 shadow-none"><p className="text-sm">Showing the last loaded events; updates could not be checked.</p>{recovery(eventsError)}</SurfaceCard> : null}
            {unreadableCalendars.length ? <p role="status" className="text-xs text-muted-foreground">Event details are not shared for {unreadableCalendars.map(calendar => calendar.name || calendar.id).join(", ")}. Their busy times are included in availability checks.</p> : null}
            {events?.length === 0 && !eventsError ? <SurfaceCard className="p-6 shadow-none"><p>{eventsLoading ? "Last check found no events." : date === today ? "No events today." : "No events on this day."}</p><p className="mt-1 text-sm text-muted-foreground">{eventsLoading ? "Updates have not been confirmed yet." : unreadableCalendars.length ? "No events in calendars that share event details." : "Your included calendars are clear."}</p></SurfaceCard> : <>
              {allDay.length ? <div className="space-y-2"><h3 className={`${presentationStyles.sourceGroup} text-muted-foreground`}>All-day events</h3>{timeline(allDay)}</div> : null}
              {timed.length ? timeline(timed) : null}
            </>}
          </>}
        </section> : <section aria-label="Free time" aria-busy={availabilityLoading} className="space-y-2.5">
          <SurfaceCard className="space-y-3.5 p-[15px] shadow-none sm:space-y-[15px] sm:p-4">
            <div className="flex min-h-[73px] items-center gap-[15px] sm:gap-[22px]"><span aria-hidden className="flex h-16 w-[60px] shrink-0 items-center justify-center rounded-[15px] bg-[color:var(--app-card-surface-compact)] sm:h-[73px] sm:w-[74px]"><CalendarAvailabilityArt /></span><div className="min-w-0"><h2 aria-live="polite">{availabilityLoading || availabilityError ? "Free time" : `${availability?.full_count || 0} available slots ${date === today ? "today" : "on this day"}`}</h2><p className={`${presentationStyles.support} mt-1 text-muted-foreground`}>{refreshingAvailability ? "Unconfirmed times" : "Find time for what matters."}</p></div></div>
            <SegmentedTabs className="gap-[7px] [&>button]:h-[38px] [&>button]:flex-1 [&>button[data-state=inactive]]:bg-[color:var(--app-card-surface-data)] sm:[&>button]:h-9" disabled={submitting || busy} variant="filter" ariaLabel="Availability duration" value={String(duration)} options={[15, 30, 60].map(value => ({ value: String(value), label: `${value} min` }))} onValueChange={value => setDuration(Number(value) as 15 | 30 | 60)} />
          </SurfaceCard>
          {availabilityLoading && !refreshingAvailability ? <CalendarLoading label="Free time loading" /> : null}
          {refreshingAvailability ? <div aria-label="Previous availability" className="space-y-3"><ul className="space-y-2">{refreshingAvailability.windows.map(window => <li key={window.start_at}><SurfaceCard className="shadow-none"><div className="flex min-h-[68px] items-center gap-3 px-4 py-2.5 sm:min-h-[65px]"><span className="min-w-0 flex-1"><span className={`${presentationStyles.windowPrimary} block`}>{availabilityTimeRangeLabel(window.start_at, window.end_at, zone, date)}</span><span className={`${presentationStyles.windowSupport} mt-1 block text-muted-foreground`}>{durationLabel(window.duration_minutes)}</span></span><span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent)]"><Plus className="size-5" /></span></div></SurfaceCard></li>)}</ul>{!refreshingAvailability.windows.length ? <SurfaceCard className="p-4 shadow-none"><p className={presentationStyles.support}>Last check found no free slots.</p></SurfaceCard> : null}{refreshingAvailability.full_count > 3 ? <p className={`${presentationStyles.support} text-muted-foreground`}>Showing 3 of {refreshingAvailability.full_count} available windows.</p> : null}<p className={`${presentationStyles.support} text-muted-foreground`}>Availability can change. These times aren't reserved.</p></div> : null}
          {availabilityError ? <SurfaceCard className="p-4 shadow-none">{recovery(availabilityError, true)}</SurfaceCard> : availability && !availabilityLoading ? <div aria-live="polite" className="space-y-3">
            {availability.windows.length ? <ul className="space-y-2">{availability.windows.map(window => <li key={window.start_at}><SurfaceCard className="shadow-none"><button type="button" aria-label={`Ask One about ${timeRangeLabel(window.start_at, window.end_at, zone)}`} className="flex min-h-[68px] w-full items-center gap-3 rounded-[var(--app-card-radius-standard)] px-4 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] sm:min-h-[65px]" onClick={() => {
              const slot: CalendarSlotHandoff = { ownerId: userId, accountEmail: status.google_email || "", date, windowStart: window.start_at, windowEnd: window.end_at, durationMinutes: duration, timeZone: zone };
              if (!earliestCalendarSlot(slot)) { void checkAvailability(); return; }
              onChat(undefined, slot);
            }}><span className="min-w-0 flex-1"><span className={`${presentationStyles.windowPrimary} block`}>{availabilityTimeRangeLabel(window.start_at, window.end_at, zone, date)}</span><span className={`${presentationStyles.windowSupport} mt-1 block text-muted-foreground`}>{durationLabel(window.duration_minutes)}</span></span><span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent)]"><Plus className="size-5" aria-hidden="true" /></span></button></SurfaceCard></li>)}</ul> : <SurfaceCard className="p-4 shadow-none"><p className={presentationStyles.support}>No free slots in this window.</p></SurfaceCard>}
            {availability.full_count > 3 ? <p className={`${presentationStyles.support} text-muted-foreground`}>Showing 3 of {availability.full_count} available windows.</p> : null}
            <p className={`${presentationStyles.support} text-muted-foreground`}>Availability can change. These times aren't reserved.</p>
          </div> : null}
          <SurfaceCard className="shadow-none bg-[color:var(--app-card-surface-surface)]"><button type="button" onClick={() => onChat(`Help me find a different time on ${date} in ${zone} for a ${duration}-minute meeting. Check the full selected local day.`)} className="flex min-h-[90px] w-full items-start gap-[14px] px-3 py-[14px] text-left sm:gap-[17px] sm:px-4 sm:py-[13px] focus-visible:rounded-[var(--app-card-radius-standard)] focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"><CalendarHelperIcon /><span><span className="block text-sm font-normal">Need a different time?</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">Just ask One to find time, schedule a meeting or reschedule for you.</span></span></button></SurfaceCard>
        </section>}

      </div>}
      {tab !== "insights" ? calendarFooter : null}
    </div>
    <Dialog modal open={settingsActive} onOpenChange={open => { if (!open && pendingExclusion) setPendingExclusion(null); else setSettingsOpen(open); }}>
      <DialogContent className={`${presentationStyles.portal} max-h-[85dvh] overflow-y-auto`} onEscapeKeyDown={event => { if (pendingExclusion) { event.preventDefault(); setPendingExclusion(null); } }} onCloseAutoFocus={event => { if (settingsTrigger.current?.isConnected) { event.preventDefault(); settingsTrigger.current.focus(); } }}><DialogHeader><DialogTitle>Calendar settings</DialogTitle><DialogDescription>Time zone and calendars for this session. Free time checks the whole selected day.</DialogDescription></DialogHeader>
        <label className="space-y-2"><span className="text-sm font-semibold">Time zone</span><Input aria-label="Time zone" value={zoneInput} onChange={event => setZoneInput(event.target.value)} /></label>
        <fieldset className="grid grid-cols-2 gap-3"><legend className="mb-2 text-sm font-semibold">Alternative meeting hours</legend><label className="space-y-2"><span className="text-sm font-semibold text-muted-foreground">From</span><Input aria-label="Availability window start" type="time" value={settingsStart} onChange={event => setSettingsStart(event.target.value)} /></label><label className="space-y-2"><span className="text-sm font-semibold text-muted-foreground">Until</span><Input aria-label="Availability window end" type="time" value={settingsEnd} onChange={event => setSettingsEnd(event.target.value)} /></label></fieldset>
        <fieldset className="space-y-3"><legend className="text-sm font-medium">Calendars used for Free time</legend>
          <p className="text-xs text-muted-foreground">Google holiday feeds are informational by default. These choices only affect Free time; calendars stay visible in Schedule.</p>
          {!calendarOptions.length ? <p className="text-sm">Open Free time to load your calendars.</p> : <ul className="space-y-3">{calendarOptions.map(calendar => {
            const included = selectionDraft.overrides[calendar.id] ?? calendar.availability_default_included !== false;
            return <li key={calendar.id} aria-label={calendar.name || calendar.id} className="space-y-1">
              <p className="break-words text-sm font-medium">{calendar.name || calendar.id}</p>
              <p className="text-xs text-muted-foreground">{included ? "Blocks availability" : calendar.availability_default_included === false ? "Informational holiday feed" : "Excluded from availability"}</p>
              <CalendarCompactAction disabled={Boolean(pendingExclusion)} onClick={() => included ? setPendingExclusion(calendar) : setSelectionDraft(current => ({ ...current, overrides: { ...current.overrides, [calendar.id]: true } }))}>{included ? "Exclude this calendar from availability" : "Include in availability"}</CalendarCompactAction>
            </li>;
          })}</ul>}
          {pendingExclusion ? <div role="alert" className="space-y-2 rounded-lg border p-3">
            <p className="text-sm">Exclude {pendingExclusion.name || pendingExclusion.id} from availability? Free time may overlap its events. It will remain visible in Schedule.</p>
            <div className="flex flex-wrap gap-2"><Button variant="ghost" size="compact" className={presentationStyles.utility} onClick={() => setPendingExclusion(null)}>Keep included</Button><Button onClick={() => { setSelectionDraft(current => ({ ...current, overrides: { ...current.overrides, [pendingExclusion.id]: false } })); setPendingExclusion(null); }}>Confirm exclusion</Button></div>
          </div> : null}
        </fieldset>
        {zoneError ? <p role="alert" className="text-sm text-destructive">{zoneError}</p> : null}
        <Button disabled={Boolean(pendingExclusion)} onClick={saveSettings}>Save settings</Button>
      </DialogContent>
    </Dialog>
    <Dialog modal open={Boolean(selected)} onOpenChange={open => { if (!open) closeDetails(); }}>
      <DialogContent className={`${presentationStyles.portal} max-h-[80dvh] overflow-y-auto`} onCloseAutoFocus={event => { event.preventDefault(); if (detailTrigger.current?.isConnected) detailTrigger.current.focus(); else refreshButton.current?.focus(); }} onEscapeKeyDown={event => { if (submittingRef.current) event.preventDefault(); }} onInteractOutside={event => { if (submittingRef.current) event.preventDefault(); }}>
        {selected ? <>
        <DialogHeader><DialogTitle>{step === "review" ? "Review your response" : step === "result" ? "Your response" : selected?.title}</DialogTitle><DialogDescription>{selected ? `${eventTime(selected, zone)} · ${zone}` : "Invitation details"}</DialogDescription></DialogHeader>
        {connectionNotice}
        {step === "details" && selected ? <div className="space-y-4">
          {selected.description ? <p className="whitespace-pre-wrap break-words text-sm">{selected.description}</p> : null}
          {selected.location ? <p className="text-sm">{selected.location}</p> : null}
          {selected.organizer?.email ? <p className="break-all text-sm text-muted-foreground">Organizer: {selected.organizer.email}</p> : null}
          {isCalendarEventEnded(selected, now, zone) ? <p className={`${presentationStyles.status} text-muted-foreground`}>Ended</p> : safeMeetingUrl(selected.conference_url) ? <a className={presentationStyles.joinLink} href={safeMeetingUrl(selected.conference_url)!} target="_blank" rel="noopener noreferrer">Join meeting</a> : null}
          {selected.can_decline ? <CalendarCompactAction onClick={() => { setStep("choice"); setResult(null); setReview(null); }}>Can't attend</CalendarCompactAction> : <p className="text-sm text-muted-foreground">Attendance changes are available on invitations to your connected account.</p>}
        </div> : step === "choice" ? <div className="space-y-4">
          <fieldset disabled={submitting || busy} className="space-y-2"><legend className="text-sm font-semibold">Can't attend</legend><label className="flex min-h-11 items-center gap-3"><input type="radio" name="attendance" checked={!offerTimes} onChange={() => setOfferTimes(false)} />Decline only</label><label className="flex min-h-11 items-center gap-3"><input type="radio" name="attendance" checked={offerTimes} onChange={() => setOfferTimes(true)} />Decline &amp; offer another time</label></fieldset>
          <p className="text-sm text-muted-foreground">Only your attendance response changes. The organizer keeps the meeting.</p>
          {offerTimes ? <><label className="block space-y-[var(--app-form-field-gap)]"><span className="text-sm font-semibold">Message to organizer</span><Textarea disabled={submitting || busy} aria-label="Message to organizer" rows={4} value={message} onChange={event => setMessage(event.target.value)} /></label>{windowControls("Alternative")}<p className="text-xs text-muted-foreground">{zone}. A recipient-accessible link to checked alternatives will be included for review. The organizer chooses a time and updates the invitation.</p></> : null}
          {status.access_level !== "manage" ? <CalendarCompactAction disabled={busy} onClick={() => onConnect("manage")}>Allow attendance changes</CalendarCompactAction> : <CalendarCompactAction disabled={submitting || busy} onClick={() => void prepareReview()}>{submitting ? "Preparing review…" : "Review"}</CalendarCompactAction>}
        </div> : step === "review" && review ? <div className="space-y-4">
          <p>Decline your attendance at <strong>{review.title}</strong>.</p>
          {review.message ? <><p className="break-all text-sm">From: {review.sender_label}<br />To: {review.recipient}</p><p className="text-sm font-semibold">{review.subject}</p><p className="whitespace-pre-wrap break-words text-sm">{review.rescheduling_link ? review.message.replace(review.rescheduling_link, "").trim() : review.message}</p>{review.rescheduling_link ? <a href={review.rescheduling_link} target="_blank" rel="noopener noreferrer" className={presentationStyles.sourceLink}>Review recipient rescheduling link</a> : null}<p className="text-xs text-muted-foreground">Link expires in 3 days. The organizer can view the offered times without signing in to One and reply with a choice.</p></> : <p className="text-sm text-muted-foreground">Google Calendar will record your declined attendance.</p>}
          <div className="flex flex-wrap gap-2"><Button variant="ghost" size="compact" className={presentationStyles.utility} disabled={submitting} onClick={() => { setStep("choice"); setReview(null); }}>Edit</Button><Button disabled={submitting || busy} onClick={() => void confirm()}>{submitting ? "Confirming…" : "Confirm"}</Button></div>
        </div> : result ? <div role="status" className="space-y-3"><p>{result.calendar === "declined" ? "Your attendance was declined." : result.calendar === "unknown" ? "Calendar response could not be confirmed. Check the invitation before trying again." : "Your attendance could not be declined."}</p>{result.calendar_error ? <p className="text-sm text-muted-foreground">{result.calendar_error}</p> : null}{result.email === "sent" ? <p>The organizer's email was sent.</p> : result.email === "failed" || result.email === "unknown" ? <p className="text-sm text-destructive">{result.email_error || "Organizer email delivery could not be confirmed. Check Sent Mail before trying again."}</p> : offerTimes ? <p className="text-sm text-muted-foreground">The organizer's email was not sent.</p> : null}<Button variant="ghost" size="compact" className={presentationStyles.utility} onClick={closeDetails}>Done</Button></div> : null}
        {actionError ? <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{actionError.message}</p>{actionError instanceof GoogleCalendarError && actionError.reasonCode?.startsWith("GMAIL") && onMailConnect ? <CalendarCompactAction disabled={submitting} onClick={() => void runAction(onMailConnect)}>Enable Mail sending</CalendarCompactAction> : actionError instanceof GoogleCalendarError && actionError.recovery === "permission" ? <CalendarCompactAction disabled={busy} onClick={() => onConnect(actionError.reasonCode === "calendar_list_permission_required" ? "read" : "manage", actionError.reasonCode === "calendar_list_permission_required")}>Allow Calendar access</CalendarCompactAction> : null}</div> : null}
        </> : <DialogHeader><DialogTitle>Calendar</DialogTitle><DialogDescription>Calendar access is being restored.</DialogDescription></DialogHeader>}
      </DialogContent>
    </Dialog>
  </AppPageShell>;
}
