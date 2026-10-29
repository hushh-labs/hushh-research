"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bar, BarChart, XAxis } from "recharts";
import { ChevronLeft, ChevronRight, FileText, CameraIcon as Video, ExternalLink, Search } from "@/components/icons";
import { SectionCard } from "@/lib/morphy-ux/ui/surface-primitives";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CHART_TOOLTIP_TRIGGER, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CalendarInsightsRequestError, CalendarInsightsService, safeMeetingProviderUrl, type CalendarInsights as Overview, type MeetingLibrary, type MeetingDetail, type Meeting, type MeetingArtifact, type MeetingSource, type VerifiedMeetingSelection } from "@/lib/services/calendar-insights-service";
import type { GoogleCalendarAccount } from "@/lib/services/google-calendar-service";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarDateNavigation } from "./calendar-date-navigation";
import { CalendarCompactAction } from "./calendar-compact-action";
import { CalendarLoading } from "./calendar-loading";
import type { CalendarMeetingReturnContext } from "@/lib/calendar/calendar-oauth-journey";
import presentationStyles from "./calendar-presentation.module.css";
import styles from "./calendar-insights.module.css";

const hours = (minutes: number) => String(Math.round(minutes / 6) / 10) + " hr";
type SourcedArtifact = MeetingArtifact & { source?: MeetingSource };
const limitationText: Record<string, string> = {
  permission_required: "Allow recording and notes access for this Google account.",
  resource_denied: "Google denied access to one or more meeting files. Check file sharing or organization access.",
  account_mismatch: "The selected Google account no longer matches this meeting grant. Refresh the account.",
  provider_configuration: "Google's meeting-file service is not available for this connection. Check the provider configuration.",
  provider_policy: "Your Google organization does not allow this meeting-file check.",
  processing: "Google is still preparing meeting files. Refresh later.",
  temporarily_unavailable: "Google could not finish checking meeting files. Try again.",
  unverified: "A reused meeting link could not be matched to one occurrence.",
  files_incomplete: "Some meeting files could not be checked.",
  calendar_unreadable: "Some subscribed calendars do not share event details.",
  calendar_incomplete: "Calendar returned an incomplete page.",
  request_budget: "More meetings remain to be checked. Continue this day.",
  provider_retention: "Google Meet records for this older day may have expired; coverage cannot be confirmed.",
  attendee_discovery_limited: "An attendee's shared meeting files may be missing from this check.",
};

function NotePreview({ item }: { item: MeetingArtifact }) {
  if (!item.text) return null;
  if (item.text_format !== "markdown") return <div className={styles.notes}>{item.text}</div>;
  return <div className={styles.notes}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
    allowedElements={["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "blockquote", "code", "pre", "table", "thead", "tbody", "tr", "th", "td", "a"]}
    components={{ a: ({ children }) => <span>{children}</span> }}>{item.text}</ReactMarkdown></div>;
}

function Artifact({ item, onOpen, onDownload }: { item: MeetingArtifact; onOpen: (item: MeetingArtifact) => void; onDownload: (item: MeetingArtifact) => void }) {
  if (item.state !== "available" || (item.kind !== "recording" && item.kind !== "notes")) return null;
  const link = safeMeetingProviderUrl(item.url);
  return <div className="space-y-2 border-b py-3 last:border-0">
    <strong className="block break-words">{item.title || (item.kind === "recording" ? "Meeting recording" : "Meeting notes")}</strong>
    {item.provenance === "calendar_linked" ? <span className={styles.muted}>Linked from this Calendar event</span> : null}
    <div className="flex flex-wrap items-center gap-3">
      {link ? <Button variant="ghost" size="compact" className={presentationStyles.utility} onClick={() => onOpen(item)}>Open<ExternalLink className="size-3" /></Button> : <span className={styles.muted}>Google did not provide an opening link.</span>}
      {item.can_download ? <Button variant="ghost" size="compact" className={presentationStyles.utility} onClick={() => onDownload(item)}>Download</Button> : <span className={styles.muted}>The file owner does not allow downloads.</span>}
    </div>
    <NotePreview item={item} />
    {item.truncated ? <p className={styles.muted}>Preview shortened. Open or download the full note.</p> : null}
    {item.preview_state && !item.text ? <p className={styles.muted}>Preview unavailable. Open the source to read it.</p> : null}
  </div>;
}

function mergeLibrary(previous: MeetingLibrary | null, incoming: MeetingLibrary): MeetingLibrary {
  if (!previous) return incoming;
  const meetings = new Map(previous.meetings.map(meeting => [meeting.occurrence_id, meeting]));
  for (const meeting of incoming.meetings) {
    const older = meetings.get(meeting.occurrence_id);
    if (!older) { meetings.set(meeting.occurrence_id, meeting); continue; }
    const sources = new Map([...older.sources, ...meeting.sources].map(source => [source.calendar_id + ":" + source.event_id, source]));
    meetings.set(meeting.occurrence_id, {
      ...older, artifact_kinds: Array.from(new Set([...older.artifact_kinds, ...meeting.artifact_kinds])),
      sources: Array.from(sources.values()),
    });
  }
  const limitationSet = new Set([...previous.limitations, ...incoming.limitations]);
  if (!incoming.next_cursor) limitationSet.delete("request_budget");
  const limitations = Array.from(limitationSet);
  return {
    ...incoming, meetings: Array.from(meetings.values()).sort((left, right) =>
      Date.parse(right.start?.dateTime || "") - Date.parse(left.start?.dateTime || "")),
    limitations,
    complete: incoming.complete && limitations.length === 0,
    checked_events: previous.checked_events + incoming.checked_events,
  };
}

export function CalendarInsights({ userId, account, today, zone, connectionRevision, refreshRevision = 0, refreshControl = "inline", initialLibrary, getIdToken, onAllowMeetingFiles }: {
  userId: string; account: GoogleCalendarAccount; today: string; zone: string;
  connectionRevision?: number; refreshRevision?: number; refreshControl?: "inline" | "external"; initialLibrary?: CalendarMeetingReturnContext | null;
  getIdToken: () => Promise<string>; onAllowMeetingFiles?: (accountId: string, context: CalendarMeetingReturnContext) => void;
}) {
  const [view, setView] = useState<"overview" | "library" | "meeting">(initialLibrary ? "library" : "overview");
  const [day, setDay] = useState(initialLibrary?.day || today);
  const previousToday = useRef(today);
  useEffect(() => {
    if (day === previousToday.current) setDay(today);
    previousToday.current = today;
  }, [today, day]);
  const [query, setQuery] = useState(initialLibrary?.query || "");
  const [filter, setFilter] = useState<"all" | "recording" | "notes">(initialLibrary?.filter || "all");
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [libraryState, setLibraryState] = useState<{ key: string; value: MeetingLibrary } | null>(null);
  const [detail, setDetail] = useState<(MeetingDetail & { artifacts: SourcedArtifact[] }) | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [canRefresh, setCanRefresh] = useState(() => typeof document === "undefined" || (document.visibilityState !== "hidden" && navigator.onLine));
  const refreshBudget = useRef(5);
  const autoAdvance = useRef(0);
  const lastForeground = useRef(0);
  const lifetime = useRef<AbortController | null>(null);
  const action = useRef<{ controller: AbortController; popup: Window } | null>(null);
  const loadedPageCount = useRef(0);
  const refreshTarget = useRef(0);
  const refreshChecked = useRef(0);
  const refreshStage = useRef<MeetingLibrary | null>(null);
  const getToken = useRef(getIdToken); getToken.current = getIdToken;
  const epoch = snapshotVaultSessionEpoch();
  const owner = snapshotValidatedAuthSessionOwner();
  const context = [userId, account.account_id, account.grant_generation || "", account.provider_subject_sha256 || "", day, zone, epoch, owner?.generation || "", connectionRevision || 0].join(":");
  const libraryKey = [context, query, filter].join("|");
  const library = libraryState?.key === libraryKey ? libraryState.value : null;
  const libraryRef = useRef<MeetingLibrary | null>(library); libraryRef.current = library;
  const viewRef = useRef(view); viewRef.current = view;
  const requestKey = [context, view, query, filter, cursor || "", selected?.id || "", revision].join("|");
  const current = useRef(requestKey); current.current = requestKey;
  const actionContext = context + ":" + (selected?.occurrence_id || "");
  const currentActionContext = useRef(actionContext); currentActionContext.current = actionContext;
  useEffect(() => () => { action.current?.controller.abort(); action.current?.popup.close(); action.current = null; }, [actionContext]);
  const entryRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastSelectedId = useRef<string | null>(null);

  const refresh = useCallback(() => {
    if (document.visibilityState === "hidden" || !navigator.onLine) return;
    lifetime.current?.abort();
    refreshTarget.current = viewRef.current === "library" && libraryRef.current ? Math.max(1, loadedPageCount.current) : 0;
    refreshChecked.current = 0;
    refreshStage.current = null;
    setCursor(null);
    setRevision(value => value + 1);
  }, []);
  const previousRefreshRevision = useRef(refreshRevision);
  useEffect(() => {
    if (previousRefreshRevision.current === refreshRevision) return;
    previousRefreshRevision.current = refreshRevision;
    refreshBudget.current = 5;
    autoAdvance.current = 0;
    refresh();
  }, [refreshRevision, refresh]);
  useEffect(() => {
    const resume = () => {
      const active = document.visibilityState !== "hidden" && navigator.onLine;
      setCanRefresh(active);
      if (!active) { lifetime.current?.abort(); setLoading(false); return; }
      if (Date.now() - lastForeground.current < 1000) return;
      lastForeground.current = Date.now(); refreshBudget.current = 5; refresh();
    };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [refresh]);
  useEffect(() => {
    if (!canRefresh || loading || error || view === "overview" || refreshBudget.current <= 0) return;
    const timer = window.setTimeout(() => { refreshBudget.current -= 1; refresh(); }, 60_000);
    return () => window.clearTimeout(timer);
  }, [canRefresh, loading, error, view, revision, refresh]);

  const back = useCallback(() => {
    if (view === "overview") return false;
    setError("");
    if (view === "meeting") {
      setView("library"); setSelected(null);
      requestAnimationFrame(() => rowRefs.current.get(lastSelectedId.current || "")?.focus());
    } else {
      setView("overview");
      requestAnimationFrame(() => entryRef.current?.focus());
    }
    return true;
  }, [view]);
  useBackLayer("/one/calendar", view === "meeting" ? 2 : view === "library" ? 1 : 0, back);

  useEffect(() => {
    if (!canRefresh) return;
    const controller = new AbortController();
    lifetime.current = controller;
    const requestOwner = snapshotValidatedAuthSessionOwner();
    const valid = () => !controller.signal.aborted && current.current === requestKey &&
      isVaultSessionEpochCurrent(epoch) && (!requestOwner || isValidatedAuthSessionOwnerCurrent(requestOwner));
    setLoading(true); setError("");
    const load = async () => {
      try {
        const idToken = await getToken.current();
        if (!valid()) return;
        if (view === "overview") {
          const value = await CalendarInsightsService.read<Overview>("insights",
            { date: day, time_zone: zone, account_id: account.account_id }, idToken, controller.signal);
          if (valid()) setOverview(value);
        } else if (view === "library") {
          const value = await CalendarInsightsService.read<MeetingLibrary>("meetings",
            { date: day, time_zone: zone, account_id: account.account_id, cursor, query, kind: filter },
            idToken, controller.signal);
          if (!valid()) return;
          if (value.date !== day || value.time_zone !== zone || value.account_id !== account.account_id) {
            throw new Error("Meeting page changed. Refresh this day.");
          }
          if (refreshTarget.current) {
            refreshStage.current = mergeLibrary(refreshStage.current, value);
            refreshChecked.current += 1;
            if (value.next_cursor && refreshChecked.current < refreshTarget.current) {
              setCursor(value.next_cursor);
              return;
            }
            setLibraryState({ key: libraryKey, value: refreshStage.current });
            loadedPageCount.current = refreshChecked.current;
            refreshTarget.current = 0;
            refreshStage.current = null;
          } else {
            setLibraryState(previous => ({ key: libraryKey, value: cursor && previous?.key === libraryKey ? mergeLibrary(previous.value, value) : value }));
            loadedPageCount.current = cursor ? loadedPageCount.current + 1 : 1;
          }
          if (value.next_cursor && !value.meetings.length && autoAdvance.current < 4) {
            autoAdvance.current += 1;
            setCursor(value.next_cursor);
          }
        } else if (selected) {
          const sources = selected.sources.length ? selected.sources : [{ calendar_id: selected.calendar_id, event_id: selected.id }];
          const details: (MeetingDetail & { source: MeetingSource })[] = [];
          let failedSource = false;
          for (const source of sources.slice(0, 12)) {
            const selection: VerifiedMeetingSelection = {
              account_id: account.account_id, ...source,
              occurrence_id: selected.occurrence_id, expected_grant: selected.grant_id, date: day, time_zone: zone,
            };
            let value: MeetingDetail;
            try {
              value = await CalendarInsightsService.read<MeetingDetail>("meetings/detail", selection, idToken, controller.signal);
            } catch (failure) {
              if (failure instanceof CalendarInsightsRequestError && [401, 403, 409].includes(failure.status)) throw failure;
              failedSource = true;
              continue;
            }
            if (!valid()) return;
            details.push({ ...value, source });
          }
          const files = new Map<string, SourcedArtifact>();
          for (const item of details.flatMap(value => value.artifacts.map(artifact => ({ ...artifact, source: value.source })))) {
            const key = `${item.kind}:${item.file_id}`;
            if (!files.has(key) || (files.get(key)?.state !== "available" && item.state === "available")) files.set(key, item);
          }
          const first = details[0];
          if (!first && failedSource) throw new Error("Meeting files could not be checked. Try again.");
          if (valid() && first) setDetail({ ...first, artifacts: [...files.values()],
            complete: !failedSource && sources.length <= 12 && details.every(value => value.complete),
            discovery: details.find(value => !value.complete)?.discovery || (failedSource || sources.length > 12 ? "files_incomplete" : first.discovery),
          });
        }
      } catch (failure) {
        if (valid()) {
          setError(failure instanceof Error ? failure.message : "Calendar could not be checked.");
          if (view === "overview") setOverview(null);
          if (failure instanceof CalendarInsightsRequestError && [401, 403, 409].includes(failure.status)) {
            if (view === "library") setLibraryState(null);
            if (view === "meeting") setDetail(null);
          }
        }
      } finally {
        if (valid()) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [requestKey, canRefresh, view, selected, day, zone, account.account_id, cursor, query, filter, epoch, libraryKey]);

  const changeDay = (next: string) => {
    setDay(next); setSelected(null); setDetail(null); setCursor(null);
    loadedPageCount.current = 0; refreshTarget.current = 0;
    setLibraryState(null); setError(""); autoAdvance.current = 0;
  };
  const changeQuery = (next: string) => { setQuery(next.slice(0, 120)); setCursor(null); setError(""); loadedPageCount.current = 0; refreshTarget.current = 0; autoAdvance.current = 0; };
  const changeFilter = (next: string) => {
    setFilter(next as typeof filter); setCursor(null); setError(""); loadedPageCount.current = 0; refreshTarget.current = 0; autoAdvance.current = 0;
  };
  const fileAction = (item: SourcedArtifact, kind: "open" | "download") => {
    if (!selected || (kind === "download" && !item.can_download)) return;
    const popup = window.open("about:blank", "_blank");
    if (!popup) { setError("Allow this Google file window and try again."); return; }
    popup.opener = null;
    action.current?.controller.abort(); action.current?.popup.close();
    const controller = new AbortController(); action.current = { controller, popup };
    const startedContext = actionContext;
    const selection: VerifiedMeetingSelection & { file_id: string } = {
      account_id: account.account_id, calendar_id: item.source?.calendar_id || selected.calendar_id, event_id: item.source?.event_id || selected.id,
      occurrence_id: selected.occurrence_id, expected_grant: selected.grant_id, date: day, time_zone: zone, file_id: item.file_id,
    };
    void getToken.current().then(token => CalendarInsightsService.fileAction(kind, selection, token, controller.signal))
      .then(url => {
        if (controller.signal.aborted || currentActionContext.current !== startedContext || popup.closed) { popup.close(); return; }
        const target = new URL(url);
        if (account.google_email) target.searchParams.set("authuser", account.google_email);
        popup.location.replace(target.toString());
        action.current = null;
      })
      .catch(failure => { popup.close(); if (!controller.signal.aborted && currentActionContext.current === startedContext) setError(failure instanceof Error ? failure.message : "Google file access could not be checked."); });
  };
  const visibleArtifacts = (detail?.artifacts || []).filter(item =>
    item.state === "available" && (item.kind === "recording" || item.kind === "notes"));
  const firstLoading = canRefresh && loading && (view === "overview" ? !overview : view === "library" ? !library : !detail);

  return <div className={styles.insights} data-view={view} aria-busy={loading}>
    {refreshControl === "inline" ? <div className="flex justify-end"><Button variant="ghost" size="compact" className={presentationStyles.utility}
      disabled={loading || !canRefresh} onClick={() => { refreshBudget.current = 5; autoAdvance.current = 0; refresh(); }}>Refresh</Button></div> : null}
    {!canRefresh ? <p role="status">Updates paused while this page is hidden or offline.</p> : null}
    {view !== "overview" ? <div className={styles.breadcrumb}><Button variant="ghost" size="icon-touch"
      aria-label={view === "meeting" ? "Back to recordings and notes" : "Back to Insights"} onClick={back}>
      <ChevronLeft className="size-4" /></Button>Insights / {view === "meeting" ? "Recordings & Notes" : "Meeting library"}</div> : null}
    {error ? <SectionCard><p role="alert">{error}</p><CalendarCompactAction onClick={refresh}>Try again</CalendarCompactAction></SectionCard> : null}
    {firstLoading ? <CalendarLoading label="Insights loading" /> : null}
    {view === "overview" ? <>
      <p className={styles.muted}>Understand your time. Make room for what matters.</p>
      <SectionCard title="Executive snapshot" description="This week · scheduled time, not attendance statistics">
        {overview ? <><div className={styles.metrics}><div><strong>{overview.meeting_count}</strong><span>Scheduled events</span></div><div><strong>{hours(overview.meeting_minutes)}</strong><span>Scheduled time</span></div><div><strong>{hours(overview.recurring.reduce((sum, row) => sum + row.minutes, 0))}</strong><span>Recurring time</span></div></div>{!overview.complete ? <p className={styles.muted}>Partial calendar coverage. Totals include only loaded events.</p> : null}</> : <Skeleton aria-label="Snapshot loading" className="h-16 w-full" />}
      </SectionCard>
      <SectionCard title="Your week at a glance">
        {overview ? <ChartContainer className="h-40 w-full" config={{ minutes: { label: "Scheduled minutes", color: "var(--app-accent)" } }}><BarChart accessibilityLayer data={overview.days}><XAxis dataKey="date" tickFormatter={value => new Date(String(value) + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" })} tickLine={false} axisLine={false} /><ChartTooltip trigger={CHART_TOOLTIP_TRIGGER} content={<ChartTooltipContent />} /><Bar dataKey="minutes" fill="var(--color-minutes)" radius={[4, 4, 0, 0]} isAnimationActive={false} /></BarChart></ChartContainer> : <Skeleton className="h-40 w-full" />}
      </SectionCard>
      <SectionCard title="Schedule risks"><p>{overview ? String(overview.overlaps) + " overlapping pairs · " + String(overview.back_to_back) + " back-to-back pairs" : "Schedule risks have not been checked."}</p><p className={styles.muted}>Based on scheduled, timed events in calendars you can read.</p></SectionCard>
      <SectionCard title="Recurring commitments">{overview?.recurring.length ? overview.recurring.map((row, index) => <div className={styles.row} key={index}><span className={styles.copy}>{row.title}</span><span className={styles.muted}>{hours(row.minutes)}/week</span></div>) : <p className={styles.muted}>No recurring commitments in the loaded events.</p>}</SectionCard>
      <button ref={entryRef} type="button" className={styles.entry} onClick={() => { autoAdvance.current = 0; setCursor(null); setView("library"); }}><span className={styles.icon}><Video className="size-5" /></span><span className={styles.copy}><strong>Recordings &amp; Notes</strong><span className={styles.muted}>Find recordings and notes by meeting day</span></span><ChevronRight className="size-4" /></button>
      <SectionCard title="Focus opportunities" description="Gaps of at least one hour · weekdays, 9 AM–5 PM">
        {overview?.focus.length ? overview.focus.map(window => <p key={window.start_at} className="py-2">{new Date(window.start_at).toLocaleString(undefined, { timeZone: zone, weekday: "short", hour: "numeric", minute: "2-digit" })}–{new Date(window.end_at).toLocaleTimeString(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" })}</p>) : <p className={styles.muted}>No verified focus windows to show.</p>}
      </SectionCard>
    </> : view === "library" ? <>
      <div><h2 className={styles.heading}>Recordings &amp; Notes</h2><p className={styles.muted}>Meetings on this day with a verified, accessible recording or meeting note.</p></div>
      <CalendarDateNavigation date={day} today={today} onChange={changeDay} label="Recording and notes date" />
      <label className="relative"><Search aria-hidden className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input className="pl-10" type="search" aria-label="Search meetings on this day" placeholder="Search meetings on this day" maxLength={120} value={query} onChange={event => changeQuery(event.target.value)} /></label>
      <SegmentedTabs variant="filter" ariaLabel="Recording and notes filters" value={filter} onValueChange={changeFilter} options={[{ value: "all", label: "All" }, { value: "recording", label: "Recordings" }, { value: "notes", label: "Notes" }]} />
      {loading && library ? <p role="status" className={styles.muted}>Checking for updates…</p> : null}
      {library?.limitations.length ? <div role="status" className={styles.muted}><p>{limitationText[library.limitations[0] || ""] || "Some meeting files could not be checked."}</p>{library.meeting_file_access === "missing" && onAllowMeetingFiles ? <CalendarCompactAction onClick={() => onAllowMeetingFiles(account.account_id, { accountId: account.account_id, day, timeZone: zone, filter, query })}>Allow recording and notes access</CalendarCompactAction> : null}</div> : library && !library.complete && !library.next_cursor ? <p role="status" className={styles.muted}>This check is incomplete. Refresh to try again.</p> : null}
      {library && (library.meetings.length > 0 || (library.complete && !loading && !error)) ? <SectionCard>{library.meetings.map(meeting => <button className={styles.row} type="button" key={meeting.occurrence_id} ref={node => { if (node) rowRefs.current.set(meeting.occurrence_id, node); else rowRefs.current.delete(meeting.occurrence_id); }} onClick={() => { lastSelectedId.current = meeting.occurrence_id; setSelected(meeting); setDetail(null); setView("meeting"); }}><span className={styles.icon}><FileText className="size-5" /></span><span className={styles.copy}><strong>{meeting.title}</strong><span className={styles.muted}>{meeting.start?.dateTime ? new Date(meeting.start.dateTime).toLocaleTimeString(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" }) : "Time unavailable"}</span><span className={styles.tags}>{meeting.artifact_kinds.map(kind => <span key={kind} className={styles.tag}>{kind === "recording" ? "Recording" : "Notes"}</span>)}</span></span><ChevronRight className="size-4" /></button>)}{library.complete && !library.meetings.length ? <p className={styles.muted}>{query || filter !== "all" ? "No matching recordings or notes for this day." : "No recordings or notes for this day."}</p> : null}</SectionCard> : null}
      {library?.next_cursor ? <CalendarCompactAction disabled={loading} onClick={() => setCursor(library.next_cursor)}>Continue checking this day</CalendarCompactAction> : null}
      {library?.next_cursor ? <p className={styles.muted}>Search and filters continue across the remaining Calendar pages.</p> : null}
    </> : <>
      <h2 className={styles.heading}>{detail?.event?.title || selected?.title}</h2>
      {detail && !detail.complete ? <p role="status" className={styles.muted}>{limitationText[detail.discovery] || "Some files could not be checked. Refresh later."}</p> : null}
      {detail ? <div className={styles.details}>{visibleArtifacts.some(item => item.kind === "recording") ? <SectionCard title="Recordings">{visibleArtifacts.filter(item => item.kind === "recording").map(item => <Artifact key={item.file_id} item={item} onOpen={file => fileAction(file, "open")} onDownload={file => fileAction(file, "download")} />)}</SectionCard> : null}
        {visibleArtifacts.some(item => item.kind === "notes") ? <SectionCard title="Meeting notes">{visibleArtifacts.filter(item => item.kind === "notes").map(item => <Artifact key={item.file_id} item={item} onOpen={file => fileAction(file, "open")} onDownload={file => fileAction(file, "download")} />)}</SectionCard> : null}</div> : null}
    </>}
  </div>;
}
