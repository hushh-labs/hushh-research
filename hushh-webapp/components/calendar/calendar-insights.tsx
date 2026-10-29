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
import { CalendarInsightsRequestError, CalendarInsightsService, safeMeetingProviderUrl, type CalendarInsights as Overview, type MeetingLibrary, type MeetingDetail, type Meeting, type MeetingArtifact, type MeetingSource, type MeetingRequestOutcome, type VerifiedMeetingSelection } from "@/lib/services/calendar-insights-service";
import type { GoogleCalendarAccount } from "@/lib/services/google-calendar-service";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarDateNavigation } from "./calendar-date-navigation";
import { CalendarCompactAction } from "./calendar-compact-action";
import { coalescedInsightsRead, insightsResourceKey, insightsSnapshot, invalidateInsightsSnapshots, storeInsightsSnapshot } from "@/lib/calendar/calendar-insights-resource";
import { calendarRefreshKey } from "@/lib/calendar/calendar-refresh";
import { CacheService } from "@/lib/services/cache-service";
import { focusedStatus, meetingTime } from "./calendar-insights-presentation";
import { FEED_STATE_CHANGED_EVENT, feedStateChangeReason } from "@/lib/feed/feed-events";
import { buildInviteToOneUrl } from "@/lib/connect/invite-to-one";
import type { CalendarMeetingReturnContext } from "@/lib/calendar/calendar-oauth-journey";
import presentationStyles from "./calendar-presentation.module.css";
import styles from "./calendar-insights.module.css";

const hours = (minutes: number) => String(Math.round(minutes / 6) / 10) + " hr";
const noVaultToken = () => null;
type SourcedArtifact = MeetingArtifact & { source?: MeetingSource };
const limitationText: Record<string, string> = {
  permission_required: "Allow recording and notes access for this Google account.",
  resource_denied: "Google denied access to an exact linked file. Check its sharing or organization policy.",
  meet_discovery_denied: "Google denied the Meet discovery check. Whether a recording or notes exist is unknown.",
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
    {item.provenance === "calendar_linked" ? <span className={styles.muted}>Linked from this Calendar event</span> : item.provenance === "approved_request" ? <span className={styles.muted}>Shared after the organizer approved your request</span> : null}
    <div className="flex flex-wrap items-center gap-3">
      {link ? <Button variant="ghost" size="compact" className={presentationStyles.utility} onClick={() => onOpen(item)}>Open<ExternalLink className="size-3" /></Button> : <span className={styles.muted}>Google did not provide an opening link.</span>}
      {item.can_download ? <Button variant="ghost" size="compact" className={presentationStyles.utility} onClick={() => onDownload(item)}>Download</Button> : <span className={styles.muted}>{item.download_reason === "app_permission" ? "Open in Google to use any download your account permits." : item.download_reason === "link_unavailable" ? "Google did not provide a download link." : "The file owner does not allow downloads."}</span>}
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
    const artifactKinds = Array.from(new Set([...older.artifact_kinds, ...meeting.artifact_kinds]));
    meetings.set(meeting.occurrence_id, {
      ...older, artifact_kinds: artifactKinds,
      availability: Object.fromEntries((["recording", "notes"] as const).map(kind => [kind,
        artifactKinds.includes(kind) ? "available" : meeting.availability[kind] || older.availability[kind] || "unverified"])),
      discovery: meeting.discovery === "checked" ? meeting.discovery : older.discovery,
      file_state: artifactKinds.length ? "available" : meeting.file_state,
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

export function CalendarInsights({ userId, account, today, zone, connectionRevision, refreshRevision = 0, refreshControl = "inline", initialLibrary, getIdToken, getVaultOwnerToken = noVaultToken, onAllowMeetingFiles }: {
  userId: string; account: GoogleCalendarAccount; today: string; zone: string;
  connectionRevision?: number; refreshRevision?: number; refreshControl?: "inline" | "external"; initialLibrary?: CalendarMeetingReturnContext | null;
  getIdToken: () => Promise<string>; getVaultOwnerToken?: () => string | null;
  onAllowMeetingFiles?: (accountId: string, context: CalendarMeetingReturnContext) => void;
}) {
  const [view, setView] = useState<"overview" | "library" | "meeting">(initialLibrary ? "library" : "overview");
  const [day, setDay] = useState(initialLibrary?.day || today);
  const previousToday = useRef(today);
  useEffect(() => {
    if (day === previousToday.current) setDay(today);
    previousToday.current = today;
  }, [today, day]);
  const [query, setQuery] = useState(initialLibrary?.query || "");
  const [queryInput, setQueryInput] = useState(initialLibrary?.query || "");
  const [filter, setFilter] = useState<"all" | "recording" | "notes">(initialLibrary?.filter || "all");
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [overviewState, setOverviewState] = useState<{ key: string; value: Overview } | null>(null);
  const [libraryState, setLibraryState] = useState<{ key: string; value: MeetingLibrary } | null>(null);
  const [detailState, setDetailState] = useState<{ key: string; value: MeetingDetail & { artifacts: SourcedArtifact[] } } | null>(null);
  const [outcomesState, setOutcomesState] = useState<{ key: string; value: Record<string, MeetingRequestOutcome> } | null>(null);
  const [requestChoice, setRequestChoice] = useState<("recording" | "notes")[]>([]);
  const [requestStep, setRequestStep] = useState<"closed" | "choose" | "confirm">("closed");
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestNotice, setRequestNotice] = useState("");
  const [offerCopyFallback, setOfferCopyFallback] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [canRefresh, setCanRefresh] = useState(() => typeof document === "undefined" || (document.visibilityState !== "hidden" && navigator.onLine));
  const refreshBudget = useRef(5);
  const autoAdvance = useRef(0);
  const lastForeground = useRef(0);
  const lastFeedRefresh = useRef(0);
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
  const overviewKey = insightsResourceKey(userId, ["overview", context]);
  const libraryKey = insightsResourceKey(userId, ["library", context, query, filter]);
  const searchPending = queryInput !== query;
  const overview = overviewState?.key === overviewKey ? overviewState.value : insightsSnapshot<Overview>(overviewKey);
  const library = searchPending ? null : libraryState?.key === libraryKey ? libraryState.value : insightsSnapshot<MeetingLibrary>(libraryKey);
  const actionContext = context + ":" + (selected?.occurrence_id || "");
  const detail = detailState?.key === actionContext ? detailState.value : null;
  const outcomes = outcomesState?.key === context ? outcomesState.value : {};
  const setDetail = useCallback((next: (MeetingDetail & { artifacts: SourcedArtifact[] }) | null | ((previous: (MeetingDetail & { artifacts: SourcedArtifact[] }) | null) => (MeetingDetail & { artifacts: SourcedArtifact[] }) | null)) =>
    setDetailState(previous => {
      const current = previous?.key === actionContext ? previous.value : null;
      const value = typeof next === "function" ? next(current) : next;
      return value ? { key: actionContext, value } : null;
    }), [actionContext]);
  const setOutcomes = useCallback((next: Record<string, MeetingRequestOutcome> | ((previous: Record<string, MeetingRequestOutcome>) => Record<string, MeetingRequestOutcome>)) =>
    setOutcomesState(previous => ({ key: context, value: typeof next === "function" ? next(previous?.key === context ? previous.value : {}) : next })), [context]);
  const libraryRef = useRef<MeetingLibrary | null>(library); libraryRef.current = library;
  const viewRef = useRef(view); viewRef.current = view;
  const requestKey = [context, view, query, filter, cursor || "", selected?.id || "", revision].join("|");
  const current = useRef(requestKey); current.current = requestKey;
  const currentActionContext = useRef(actionContext); currentActionContext.current = actionContext;
  useEffect(() => {
    if (!searchPending) return;
    const timer = window.setTimeout(() => {
      setQuery(queryInput);
      setCursor(null);
      loadedPageCount.current = 0;
      refreshTarget.current = 0;
      autoAdvance.current = 0;
    }, 250);
    return () => window.clearTimeout(timer);
  }, [queryInput, searchPending]);
  useEffect(() => { setRequestStep("closed"); setRequestChoice([]); setRequestNotice(""); setOfferCopyFallback(false); }, [actionContext]);
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
  useEffect(() => {
    const onFeed = (event: Event) => {
      if (feedStateChangeReason(event) === "read" || viewRef.current === "overview") return;
      if (Date.now() - lastFeedRefresh.current < 5_000) return;
      lastFeedRefresh.current = Date.now();
      refreshBudget.current = 5;
      refresh();
    };
    window.addEventListener(FEED_STATE_CHANGED_EVENT, onFeed);
    return () => window.removeEventListener(FEED_STATE_CHANGED_EVENT, onFeed);
  }, [refresh]);
  useEffect(() => CacheService.getInstance().subscribe(event => {
    if (event.type === "set" && event.key === calendarRefreshKey(userId)) refresh();
  }), [userId, refresh]);

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
          const value = await coalescedInsightsRead(overviewKey, controller.signal, signal =>
            CalendarInsightsService.read<Overview>("insights",
              { date: day, time_zone: zone, account_id: account.account_id }, idToken, signal));
          if (valid()) {
            setOverviewState({ key: overviewKey, value });
            storeInsightsSnapshot(overviewKey, value);
          }
        } else if (view === "library") {
          const value = await coalescedInsightsRead(libraryKey + ":" + (cursor || "first"), controller.signal, signal =>
            CalendarInsightsService.read<MeetingLibrary>("meetings",
              { date: day, time_zone: zone, account_id: account.account_id, cursor, query, kind: filter },
              idToken, signal));
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
            storeInsightsSnapshot(libraryKey, refreshStage.current);
            loadedPageCount.current = refreshChecked.current;
            refreshTarget.current = 0;
            refreshStage.current = null;
          } else {
            const next = cursor && libraryRef.current ? mergeLibrary(libraryRef.current, value) : value;
            setLibraryState({ key: libraryKey, value: next });
            storeInsightsSnapshot(libraryKey, next);
            loadedPageCount.current = cursor ? loadedPageCount.current + 1 : 1;
          }
          if (value.next_cursor && !value.meetings.length && autoAdvance.current < 4) {
            autoAdvance.current += 1;
            setCursor(value.next_cursor);
          }
          const vaultToken = getVaultOwnerToken();
          if (vaultToken && value.meetings.length) {
            const selections = value.meetings.map(meeting => ({
              account_id: account.account_id, calendar_id: meeting.calendar_id,
              event_id: meeting.id, occurrence_id: meeting.occurrence_id,
              expected_grant: meeting.grant_id, date: day, time_zone: zone,
            }));
            try {
              const replacements: MeetingRequestOutcome[] = [];
              for (let index = 0; index < selections.length; index += 20) {
                const page = await CalendarInsightsService.requestStatuses(selections.slice(index, index + 20), idToken, vaultToken, controller.signal);
                if (!valid()) return;
                replacements.push(...page);
              }
              setOutcomes(previous => ({ ...previous, ...Object.fromEntries(replacements.map(item => [item.occurrence_id, item] as const)) }));
            } catch {
              if (valid()) setOutcomes(previous => ({ ...previous, ...Object.fromEntries(selections.map(item => [item.occurrence_id, {
                occurrence_id: item.occurrence_id, status: "unverified" as const, requests: [], artifacts: [],
              }] as const)) }));
            }
          } else if (value.meetings.length) {
            setOutcomes(previous => {
              const next = { ...previous };
              for (const meeting of value.meetings) delete next[meeting.occurrence_id];
              return next;
            });
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
              const vaultToken = getVaultOwnerToken();
              value = vaultToken
                ? await CalendarInsightsService.approvedDetail(selection, idToken, vaultToken, controller.signal)
                : await CalendarInsightsService.read<MeetingDetail>("meetings/detail", selection, idToken, controller.signal);
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
          if (view === "overview" && failure instanceof CalendarInsightsRequestError && [401, 403, 409].includes(failure.status)) {
            setOverviewState(null);
            CacheService.getInstance().invalidate(overviewKey);
          }
          if (failure instanceof CalendarInsightsRequestError && [401, 403, 409].includes(failure.status)) {
            if (view === "library") setLibraryState(null);
            if (view === "meeting") setDetail(null);
            setOutcomesState(null);
            invalidateInsightsSnapshots(userId);
          }
        }
      } finally {
        if (valid()) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [requestKey, canRefresh, view, selected, day, zone, account.account_id, cursor, query, filter, epoch, libraryKey, overviewKey, getVaultOwnerToken, setDetail, setOutcomes, userId]);

  const changeDay = (next: string) => {
    setDay(next); setSelected(null); setDetail(null); setCursor(null);
    loadedPageCount.current = 0; refreshTarget.current = 0;
    setLibraryState(null); setError(""); autoAdvance.current = 0;
  };
  const changeQuery = (next: string) => { setQueryInput(next.slice(0, 120)); setError(""); };
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
    void getToken.current().then(token => {
      const vaultToken = getVaultOwnerToken();
      if (item.provenance === "approved_request") {
        if (!vaultToken) throw new Error("Unlock your vault to verify this shared file.");
        return CalendarInsightsService.approvedFileAction(kind, selection, token, vaultToken, controller.signal);
      }
      return CalendarInsightsService.fileAction(kind, selection, token, controller.signal);
    })
      .then(url => {
        if (controller.signal.aborted || currentActionContext.current !== startedContext || popup.closed) { popup.close(); return; }
        const target = new URL(url);
        if (account.google_email) target.searchParams.set("authuser", account.google_email);
        popup.location.replace(target.toString());
        action.current = null;
      })
      .catch(failure => {
        popup.close();
        if (controller.signal.aborted || currentActionContext.current !== startedContext) return;
        setDetail(previous => previous ? { ...previous, artifacts: previous.artifacts.map(file =>
          file.file_id === item.file_id ? { ...file, state: "unavailable" } : file) } : previous);
        setError(failure instanceof Error ? failure.message : "Google file access could not be checked.");
        if (failure instanceof CalendarInsightsRequestError && [401, 403, 409].includes(failure.status)) {
          invalidateInsightsSnapshots(userId);
          setLibraryState(null);
        }
      });
  };
  const visibleArtifacts = (detail?.artifacts || []).filter(item =>
    item.state === "available" && (item.kind === "recording" || item.kind === "notes") &&
    (filter === "all" || item.kind === filter));
  const withVerifiedRequest = (meeting: Meeting): Meeting => {
    const verified = outcomes[meeting.occurrence_id]?.artifacts.filter(item => item.state === "available").map(item => item.kind) || [];
    if (!verified.length) return meeting;
    const kinds = Array.from(new Set([...meeting.artifact_kinds, ...verified]));
    return { ...meeting, artifact_kinds: kinds, file_state: "available", availability: { ...meeting.availability,
      ...Object.fromEntries(verified.map(kind => [kind, "available"])) } };
  };
  const displayedMeetings = library?.meetings.map(withVerifiedRequest) || [];
  const availableMeetings = displayedMeetings.filter(meeting => meeting.artifact_kinds.length > 0);
  const unavailableMeetings = displayedMeetings.filter(meeting => meeting.artifact_kinds.length === 0);
  const selectedDisplayed = selected ? withVerifiedRequest(selected) : null;
  const requestOutcome = selected ? outcomes[selected.occurrence_id] : null;
  const verifiedKinds = new Set([
    ...(selectedDisplayed?.artifact_kinds || []),
    ...(detail?.artifacts.filter(item => item.state === "available").map(item => item.kind === "recording" ? "recording" : "notes") || []),
  ]);
  const missingKinds = (["recording", "notes"] as const).filter(kind => !verifiedKinds.has(kind));
  const requestStatus = (meeting: Meeting): string | null => {
    const outcome = outcomes[meeting.occurrence_id];
    if (outcome?.status === "unverified")
      return "This meeting's request status could not be verified. Refresh to try again.";
    const requests = outcome?.requests || [];
    if (!requests.length) return null;
    if (requests.some(item => item.identityStatus === "unverified"))
      return "The selected Google account changed. Reconnect it to verify access.";
    if (requests.some(item => item.status === "pending" || item.status === "preparing" || item.status === "review_ready"))
      return "Request sent · waiting for organizer review.";
    if (requests.some(item => item.status === "approved") && !meeting.artifact_kinds.length)
      return "Organizer approved · file access is still being verified.";
    if (requests.some(item => item.status === "declined")) return "Organizer declined this request.";
    if (requests.some(item => item.status === "failed" || item.status === "no_match")) return "Sharing did not complete. Ask the organizer to review again.";
    if (requests.some(item => item.status === "partial"))
      return meeting.artifact_kinds.length ? "Some files are available; others could not be shared or verified." :
        "Only part of this request was shared; no file access is verified for this account.";
    if (requests.some(item => item.status === "completed") && !meeting.artifact_kinds.length)
      return "Drive finished sharing, but file access is not currently verified for this account.";
    return null;
  };
  const submitRequest = async () => {
    if (!selected || requestBusy || !requestChoice.length) return;
    const vaultToken = getVaultOwnerToken();
    if (!vaultToken) { setRequestNotice("Unlock your vault to send this request."); return; }
    const started = currentActionContext.current;
    const selection: VerifiedMeetingSelection = {
      account_id: account.account_id, calendar_id: selected.calendar_id, event_id: selected.id,
      occurrence_id: selected.occurrence_id, expected_grant: selected.grant_id,
      date: day, time_zone: zone,
    };
    setRequestBusy(true); setRequestNotice("");
    try {
      const idToken = await getToken.current();
      const result = await CalendarInsightsService.requestFiles(selection, requestChoice, idToken, vaultToken);
      if (currentActionContext.current !== started || !isVaultSessionEpochCurrent(epoch)) return;
      setRequestStep("closed");
      setRequestNotice(`Request sent to the organizer. Files will be shared with ${result.recipientEmail} only after an exact-file approval and access check.`);
      setOutcomes(previous => ({ ...previous, [selected.occurrence_id]: {
        occurrence_id: selected.occurrence_id,
        requests: [{ requestId: result.requestId, status: result.status, requestedTypes: requestChoice }],
        artifacts: previous[selected.occurrence_id]?.artifacts || [],
      } }));
    } catch (failure) {
      if (currentActionContext.current !== started) return;
      setRequestNotice(failure instanceof Error ? failure.message : "Meeting request could not be sent.");
      setOfferCopyFallback(failure instanceof CalendarInsightsRequestError &&
        ["calendar_organizer_unavailable", "connection_required", "sharing_unavailable"].includes(failure.code || ""));
    } finally { if (currentActionContext.current === started) setRequestBusy(false); }
  };
  const copyRequestText = selected ? `Could you share the ${requestChoice.join(" and ") || "recording or notes"} for ${selected.title} (${day}) with ${account.google_email || "my selected Google Calendar account"}?${buildInviteToOneUrl() ? ` If you'd like to review the request in One, join here: ${buildInviteToOneUrl()}` : ""}` : "";
  const meetingRow = (meeting: Meeting) => <button className={styles.row} type="button" key={meeting.occurrence_id}
    ref={node => { if (node) rowRefs.current.set(meeting.occurrence_id, node); else rowRefs.current.delete(meeting.occurrence_id); }}
    onClick={() => { lastSelectedId.current = meeting.occurrence_id; setSelected(meeting); setDetail(null); setView("meeting"); }}>
    <span className={styles.icon}><FileText className="size-5" /></span>
    <span className={styles.copy}>
      <strong>{meeting.title}</strong>
      <span className={styles.muted}>{meetingTime(meeting, zone)} · Organizer: {meeting.organizer?.displayName || meeting.organizer?.email || "Unavailable"}</span>
      <span className={styles.tags}>
        {meeting.artifact_kinds.map(kind => <span key={kind} className={styles.tag}>{kind === "recording" ? "Recording" : "Notes"}</span>)}
      </span>
      <span className={styles.muted}>{requestStatus(meeting) || focusedStatus(meeting, filter)}</span>
    </span><ChevronRight className="size-4" />
  </button>;
  const errorCard = error ? <SectionCard><p role="alert">{error}</p><CalendarCompactAction onClick={refresh}>Try again</CalendarCompactAction></SectionCard> : null;

  return <div className={styles.insights} data-view={view} aria-busy={loading}>
    {refreshControl === "inline" ? <div className="flex justify-end"><Button variant="ghost" size="compact" className={presentationStyles.utility}
      disabled={loading || !canRefresh} onClick={() => { refreshBudget.current = 5; autoAdvance.current = 0; refresh(); }}>Refresh</Button></div> : null}
    {!canRefresh ? <p role="status">Updates paused while this page is hidden or offline.</p> : null}
    {view !== "overview" ? <div className={styles.breadcrumb}><Button variant="ghost" size="icon-touch"
      aria-label={view === "meeting" ? "Back to recordings and notes" : "Back to Insights"} onClick={back}>
      <ChevronLeft className="size-4" /></Button>Insights / {view === "meeting" ? "Recordings & Notes" : "Meeting library"}</div> : null}
    {view === "overview" ? <>
      <p className={styles.muted}>Understand your time. Make room for what matters.</p>
      {loading && !overview ? <p role="status" className={styles.muted}>Checking Insights…</p> : null}
      {errorCard}
      <SectionCard title="Executive snapshot" description="This week · scheduled time, not attendance statistics">
        {overview ? <><div className={styles.metrics}><div><strong>{overview.meeting_count}</strong><span>Scheduled events</span></div><div><strong>{hours(overview.meeting_minutes)}</strong><span>Scheduled time</span></div><div><strong>{hours(overview.recurring.reduce((sum, row) => sum + row.minutes, 0))}</strong><span>Recurring time</span></div></div>{!overview.complete ? <p className={styles.muted}>Partial calendar coverage. Totals include only loaded events.</p> : null}</> : error ? <p className={styles.muted}>Snapshot unavailable.</p> : <Skeleton aria-label="Snapshot loading" className="h-16 w-full" />}
      </SectionCard>
      <SectionCard title="Your week at a glance">
        {overview ? <ChartContainer className="h-40 w-full" config={{ minutes: { label: "Scheduled minutes", color: "var(--app-accent)" } }}><BarChart accessibilityLayer data={overview.days}><XAxis dataKey="date" tickFormatter={value => new Date(String(value) + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" })} tickLine={false} axisLine={false} /><ChartTooltip trigger={CHART_TOOLTIP_TRIGGER} content={<ChartTooltipContent />} /><Bar dataKey="minutes" fill="var(--color-minutes)" radius={[4, 4, 0, 0]} isAnimationActive={false} /></BarChart></ChartContainer> : error ? <p className={styles.muted}>Weekly chart unavailable.</p> : <Skeleton className="h-40 w-full" />}
      </SectionCard>
      <SectionCard title="Schedule risks"><p>{overview ? String(overview.overlaps) + " overlapping pairs · " + String(overview.back_to_back) + " back-to-back pairs" : "Schedule risks have not been checked."}</p><p className={styles.muted}>Based on scheduled, timed events in calendars you can read.</p></SectionCard>
      <SectionCard title="Recurring commitments">{overview?.recurring.length ? overview.recurring.map((row, index) => <div className={styles.row} key={index}><span className={styles.copy}>{row.title}</span><span className={styles.muted}>{hours(row.minutes)}/week</span></div>) : <p className={styles.muted}>No recurring commitments in the loaded events.</p>}</SectionCard>
      <button ref={entryRef} type="button" className={styles.entry} onClick={() => { autoAdvance.current = 0; setCursor(null); setView("library"); }}><span className={styles.icon}><Video className="size-5" /></span><span className={styles.copy}><strong>Recordings &amp; Notes</strong><span className={styles.muted}>Find recordings and notes by meeting day</span></span><ChevronRight className="size-4" /></button>
      <SectionCard title="Focus opportunities" description="Gaps of at least one hour · weekdays, 9 AM–5 PM">
        {overview?.focus.length ? overview.focus.map(window => <p key={window.start_at} className="py-2">{new Date(window.start_at).toLocaleString(undefined, { timeZone: zone, weekday: "short", hour: "numeric", minute: "2-digit" })}–{new Date(window.end_at).toLocaleTimeString(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" })}</p>) : <p className={styles.muted}>No verified focus windows to show.</p>}
      </SectionCard>
    </> : view === "library" ? <>
      <div><h2 className={styles.heading}>Recordings &amp; Notes</h2><p className={styles.muted}>Every timed meeting on this day, with file access checked separately.</p></div>
      <CalendarDateNavigation date={day} today={today} onChange={changeDay} label="Recording and notes date" />
      <label className="relative"><Search aria-hidden className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input className="pl-10" type="search" aria-label="Search meetings on this day" placeholder="Search meetings on this day" maxLength={120} value={queryInput} onChange={event => changeQuery(event.target.value)} /></label>
      <SegmentedTabs variant="filter" ariaLabel="Recording and notes filters" value={filter} onValueChange={changeFilter} options={[{ value: "all", label: "All" }, { value: "recording", label: "Recordings" }, { value: "notes", label: "Notes" }]} />
      {filter !== "all" ? <p className={styles.muted}>All meetings remain listed. The {filter === "recording" ? "recording" : "notes"} filter focuses the file detail.</p> : null}
      {searchPending ? <p role="status" className={styles.muted}>Searching meetings…</p> : !library && !error && canRefresh ? <p role="status" className={styles.muted}>Checking meetings…</p> : null}
      {loading && library ? <p role="status" className={styles.muted}>Checking for updates…</p> : null}
      {errorCard}
      {library?.limitations.length ? <div role="status" className={styles.muted}><p>{limitationText[library.limitations[0] || ""] || "Some meeting files could not be checked."}</p>{library.meeting_file_access === "missing" && onAllowMeetingFiles ? <CalendarCompactAction onClick={() => onAllowMeetingFiles(account.account_id, { accountId: account.account_id, day, timeZone: zone, filter, query })}>Allow recording and notes access</CalendarCompactAction> : null}</div> : library && !library.complete && !library.next_cursor ? <p role="status" className={styles.muted}>This check is incomplete. Refresh to try again.</p> : null}
      {library ? <p role="status" className={styles.muted}>
        {query ? "Search results: " : ""}{library.meetings.length} meetings loaded · {availableMeetings.length} Available · {unavailableMeetings.length} Not available yet.
        {query ? " Clear search to see all meetings." : null}
        {!library.calendar_complete ? " Calendar coverage is incomplete; totals reflect loaded meetings only." : null}
      </p> : null}
      {availableMeetings.length ? <SectionCard title={`Available (${availableMeetings.length})`}>{availableMeetings.map(meetingRow)}</SectionCard> : null}
      {unavailableMeetings.length ? <SectionCard title={`Not available yet (${unavailableMeetings.length})`}>{unavailableMeetings.map(meetingRow)}</SectionCard> : null}
      {library?.calendar_complete && !library.meetings.length && !loading && !error ? <SectionCard><p className={styles.muted}>{query ? "No matching meetings for this day. Clear search to see all meetings." : "No timed meetings for this day."}</p></SectionCard> : null}
      {library?.next_cursor ? <CalendarCompactAction disabled={loading} onClick={() => setCursor(library.next_cursor)}>Continue checking this day</CalendarCompactAction> : null}
      {library?.next_cursor ? <p className={styles.muted}>More Calendar pages remain. Continue this day for complete totals.</p> : null}
    </> : <>
      <h2 className={styles.heading}>{detail?.event?.title || selected?.title}</h2>
      {!detail && !error && canRefresh ? <p role="status" className={styles.muted}>Checking meeting files…</p> : null}
      {errorCard}
      {detail && !detail.complete ? <p role="status" className={styles.muted}>{limitationText[detail.discovery] || "Some files could not be checked. Refresh later."}</p> : null}
      {!visibleArtifacts.length && selectedDisplayed ? <SectionCard><p>{requestStatus(selectedDisplayed) || focusedStatus(selectedDisplayed, filter)}</p></SectionCard> : null}
      {detail ? <div className={styles.details}>{visibleArtifacts.some(item => item.kind === "recording") ? <SectionCard title="Recordings">{visibleArtifacts.filter(item => item.kind === "recording").map(item => <Artifact key={item.file_id} item={item} onOpen={file => fileAction(file, "open")} onDownload={file => fileAction(file, "download")} />)}</SectionCard> : null}
        {visibleArtifacts.some(item => item.kind === "notes") ? <SectionCard title="Meeting notes">{visibleArtifacts.filter(item => item.kind === "notes").map(item => <Artifact key={item.file_id} item={item} onOpen={file => fileAction(file, "open")} onDownload={file => fileAction(file, "download")} />)}</SectionCard> : null}</div> : null}
      {requestOutcome?.requests.length ? <p role="status" className={styles.muted}>{requestStatus(selectedDisplayed || selected!) || "Only files verified for the selected Google account appear above."}</p> : null}
      {requestOutcome?.artifacts.some(item => item.state === "permission_required") && onAllowMeetingFiles ?
        <SectionCard><p>The selected Google account needs permission to check shared file names and metadata. File content stays in Google Drive.</p>
          <CalendarCompactAction onClick={() => onAllowMeetingFiles(account.account_id, { accountId: account.account_id, day, timeZone: zone, filter, query })}>Allow recording and notes access</CalendarCompactAction>
        </SectionCard> : null}
      {requestNotice ? <p role="status" className={styles.muted}>{requestNotice}</p> : null}
      {missingKinds.length && selected ? <SectionCard title="Request missing files">
        {requestStep === "closed" ? <Button variant="outline" onClick={() => { setRequestChoice([]); setRequestStep("choose"); setOfferCopyFallback(false); }}>Request recording or notes</Button> : null}
        {requestStep === "choose" ? <div className="space-y-3"><p>Choose the files to ask the organizer for. A request does not grant access.</p>
          {missingKinds.map(kind => <label key={kind} className="flex items-center gap-2"><input type="checkbox" checked={requestChoice.includes(kind)} onChange={event => setRequestChoice(previous => event.target.checked ? [...previous, kind] : previous.filter(item => item !== kind))} />{kind === "recording" ? "Recording" : "Notes"}</label>)}
          <Button disabled={!requestChoice.length} onClick={() => setRequestStep("confirm")}>Review request</Button>
          <Button variant="ghost" onClick={() => setRequestStep("closed")}>Cancel</Button>
        </div> : null}
        {requestStep === "confirm" ? <div className="space-y-3"><p><strong>{selected.title}</strong> · {day}</p><p>Organizer: {selected.organizer?.displayName || selected.organizer?.email || "Unavailable"}</p><p>Requested: {requestChoice.join(" and ")}</p><p>Recipient Google account: <strong>{account.google_email || "Selected Calendar account"}</strong></p>
          <p>The organizer must confirm the exact files and recipient before Drive sharing. Access appears here only after your selected account can open a file.</p>
          <Button disabled={requestBusy} onClick={() => void submitRequest()}>{requestBusy ? "Sending…" : "Send request"}</Button>
          <Button variant="ghost" disabled={requestBusy} onClick={() => setRequestStep("choose")}>Back</Button>
        </div> : null}
        {offerCopyFallback ? <div className="space-y-2"><p>This request cannot be sent through One. Copy this meeting-specific request and send it directly.</p><textarea readOnly aria-label="Copy request for organizer" className="w-full rounded border p-2" rows={4} value={copyRequestText} /></div> : null}
      </SectionCard> : null}
    </>}
  </div>;
}
