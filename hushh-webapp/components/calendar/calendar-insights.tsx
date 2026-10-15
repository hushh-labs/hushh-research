"use client";

import { toast } from "sonner";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bar, BarChart, XAxis } from "recharts";
import { ChevronLeft, ChevronRight, FileText, CameraIcon as Video, ExternalLink, MessageSquareIcon as MessageSquare, Search } from "@/components/icons";
import { SectionCard } from "@/lib/morphy-ux/ui/surface-primitives";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { navigateToAgentChat } from "@/lib/navigation/agent-navigation";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { CalendarInsightsService, type CalendarInsights as Overview, type MeetingLibrary, type MeetingDetail, type Meeting, type MeetingArtifact } from "@/lib/services/calendar-insights-service";
import styles from "./calendar-insights.module.css";

const hours = (minutes: number) => `${Math.round(minutes / 6) / 10} hr`;
const availability: Record<string, string> = {
  processing: "Google is still preparing one or more meeting files. Check again later.",
  permission_required: "Permission required. Calendar access does not include access to this meeting file.",
  unavailable: "Not available or not shared with your connected account.",
  unverified: "This meeting could not be matched to one verified conference record.",
  temporarily_unavailable: "Access could not be checked. Try again.",
  source_changed: "The source changed. Refresh to check it again.",
  unsupported_format: "Preview is unavailable for this file format.",
};
function safeSource(value?: string) {
  try { const url = new URL(value || ""); return url.protocol === "https:" && ["drive.google.com", "docs.google.com"].includes(url.hostname) && !url.username && !url.password ? value : undefined; } catch { return undefined; }
}
function Artifact({ item }: { item: MeetingArtifact }) {
  const link = safeSource(item.url);
  return <div className="space-y-2 border-b py-3 last:border-0">
    {item.linked_only ? <p className={styles.muted}>Linked Calendar attachment · meeting artifact type unverified</p> : null}
    <strong className="block break-words">{item.title || (item.kind === "recording" ? "Meeting recording" : item.kind === "transcript" ? "Meeting transcript" : "Meeting notes")}</strong>
    {item.state !== "available" ? <p className={styles.muted}>{availability[item.state] || "Access could not be verified."}</p> : <>
      {link ? <a className={styles.link} href={link} target="_blank" rel="noopener noreferrer">{item.kind === "recording" ? "Watch recording" : "Open source"}<ExternalLink className="size-3" /></a> : null}
      {item.text ? <div className={styles.notes}>{item.text}</div> : item.kind !== "recording" ? <p className={styles.muted}>Open the source to read this file.</p> : null}
      {item.text ? <Button variant="ghost" size="sm" onClick={() => { void navigator.clipboard.writeText(item.text || "").then(() => toast.success("Notes copied"), () => toast.error("Could not copy notes")); }}>Copy notes</Button> : null}
      {item.truncated ? <p className={styles.muted}>Preview shortened. Open the source for the full text.</p> : null}
    </>}
  </div>;
}

export function CalendarInsights({ userId, accountKey, date, zone, getIdToken, vaultOwnerToken }: {
  userId: string; accountKey: string; date: string; zone: string; getIdToken: () => Promise<string>; vaultOwnerToken: string | null;
}) {
  const [view, setView] = useState<"overview" | "library" | "meeting">("overview");
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [detailTab, setDetailTab] = useState("notes");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [library, setLibrary] = useState<MeetingLibrary | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [asking, setAsking] = useState(false);
  const entryRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastSelectedId = useRef<string | null>(null);
  const getToken = useRef(getIdToken); getToken.current = getIdToken;
  const epoch = snapshotVaultSessionEpoch();
  const identity = `${userId}:${accountKey}:${epoch}`;
  const current = useRef(identity); current.current = identity;
  const lifetime = useRef<AbortController | null>(null);
  const back = useCallback(() => {
    if (view === "overview") return false;
    setError("");
    if (view === "meeting") { setView("library"); setSelected(null); requestAnimationFrame(() => rowRefs.current.get(lastSelectedId.current || "")?.focus()); }
    else { setView("overview"); requestAnimationFrame(() => entryRef.current?.focus()); }
    return true;
  }, [view]);
  useBackLayer("/one/calendar", view === "meeting" ? 2 : view === "library" ? 1 : 0, back);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    const valid = () => !controller.signal.aborted && current.current === identity && isVaultSessionEpochCurrent(epoch);
    setLoading(true); setAsking(false); setError(""); setDetail(null);
    const load = async () => {
      try {
        const token = await getToken.current(); if (!valid()) return;
        if (view === "meeting" && selected?.id) {
          const value = await CalendarInsightsService.read<MeetingDetail>("meetings/detail", { calendar_id: selected.calendar_id || "primary", event_id: selected.id, expected_account_email: accountKey.split(":")[0] }, token, controller.signal);
          if (valid()) setDetail(value);
        } else if (view === "library") {
          const value = await CalendarInsightsService.read<MeetingLibrary>("meetings", { date, time_zone: zone, page }, token, controller.signal);
          if (valid()) setLibrary(previous => page === 0 ? value : {
            ...value,
            meetings: Array.from(new Map([...(previous?.meetings || []), ...value.meetings]
              .map(meeting => [`${meeting.calendar_id}:${meeting.id}`, meeting])).values()),
          });
        } else {
          const value = await CalendarInsightsService.read<Overview>("insights", { date, time_zone: zone }, token, controller.signal);
          if (valid()) setOverview(value);
        }
      } catch (failure) { if (valid()) setError(failure instanceof Error ? failure.message : "Calendar could not be checked."); }
      finally { if (valid()) setLoading(false); }
    };
    void load(); return () => controller.abort();
  }, [view, selected, date, zone, identity, epoch, revision, accountKey, page]);
  const ask = async () => {
    if (!selected?.id || !vaultOwnerToken || asking) return;
    const eventId = selected.id;
    setAsking(true); setError("");
    const controller = lifetime.current;
    const valid = () => !controller?.signal.aborted && current.current === identity && isVaultSessionEpochCurrent(epoch);
    try {
      await getToken.current(); if (!valid()) return;
      if (!valid()) return;
      const createdAtMs = Date.now();
      useOneConversationSession.getState().createHandoff({ id: `calendar-meeting-${createdAtMs}`, reason: "user_requested", calendarRequest: { ownerId: userId, request: "Summarize this meeting's notes, decisions and follow-ups with source references. Do not save them to Memory or PKM.", meeting: { calendar_id: selected.calendar_id || "primary", event_id: eventId, expected_account_email: accountKey.split(":")[0] || "" } }, createdAtMs });
      navigateToAgentChat();
    } catch (failure) { if (valid()) setError(failure instanceof Error ? failure.message : "Meeting context could not be checked."); }
    finally { if (valid()) setAsking(false); }
  };
  const filtered = (library?.meetings || []).filter(meeting => {
    const kinds = meeting.artifact_kinds || [];
    return meeting.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (filter === "all" || kinds.includes(filter));
  });
  const artifacts = detail?.artifacts || [];
  return <div className={styles.insights}>
    {view !== "overview" ? <div className={styles.breadcrumb}><Button variant="ghost" size="icon" aria-label={view === "meeting" ? "Back to recordings and notes" : "Back to Insights"} onClick={back}><ChevronLeft className="size-4" /></Button>Insights / {view === "meeting" ? "Recordings & Notes" : "Meeting library"}</div> : null}
    {error ? <SectionCard><p role="alert">{error}</p><Button variant="outline" onClick={() => setRevision(value => value + 1)}>Try again</Button></SectionCard> : null}
    {loading ? <p role="status">Checking Calendar{view === "meeting" ? " and meeting file permissions" : ""}…</p> : null}
    {view === "overview" ? <>
      <div><h2 className={styles.heading}>Insights</h2><p className={styles.muted}>Understand your time. Make room for what matters.</p></div>
      <SectionCard title="Executive snapshot" description="This week · scheduled time, not attendance statistics">
        {overview ? <><div className={styles.metrics}><div><strong>{overview.meeting_count}</strong><span>Scheduled events</span></div><div><strong>{hours(overview.meeting_minutes)}</strong><span>Scheduled time</span></div><div><strong>{hours(overview.recurring.reduce((sum, row) => sum + row.minutes, 0))}</strong><span>Recurring time</span></div></div>{!overview.complete ? <p className={styles.muted}>Partial calendar coverage. Totals include only the events loaded.</p> : null}</> : <p className={styles.muted}>Live calendar information is needed for this snapshot.</p>}
      </SectionCard>
      <SectionCard title="Your week at a glance">
        {overview ? <ChartContainer className="h-40 w-full" config={{ minutes: { label: "Scheduled minutes", color: "var(--app-accent)" } }}><BarChart accessibilityLayer data={overview.days}><XAxis dataKey="date" tickFormatter={value => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" })} tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent />} /><Bar dataKey="minutes" fill="var(--color-minutes)" radius={[4, 4, 0, 0]} isAnimationActive={false} /></BarChart></ChartContainer> : <p className={styles.muted}>Weekly chart unavailable until Calendar is checked.</p>}
      </SectionCard>
      <SectionCard title="Schedule risks"><p>{overview ? `${overview.overlaps} overlapping pairs · ${overview.back_to_back} back-to-back pairs` : "Schedule risks have not been checked."}</p><p className={styles.muted}>Based on scheduled, timed events in calendars you can read.</p></SectionCard>
      <SectionCard title="Recurring commitments">{overview?.recurring.length ? overview.recurring.map((row, index) => <div className={styles.row} key={index}><span className={styles.copy}>{row.title}</span><span className={styles.muted}>{hours(row.minutes)}/week</span></div>) : <p className={styles.muted}>{overview ? "No recurring commitments in the loaded events." : "Recurring commitments have not been checked."}</p>}</SectionCard>
      <button ref={entryRef} type="button" className={styles.entry} onClick={() => { setPage(0); setLibrary(null); setView("library"); }}><span className={styles.icon}><Video className="size-5" /></span><span className={styles.copy}><strong>Recordings &amp; Notes</strong><span className={styles.muted}>Find recordings and notes from past meetings</span></span><ChevronRight className="size-4" /></button>
      <SectionCard title="Focus opportunities" description="Gaps of at least one hour · weekdays, 9 AM–5 PM">
        {overview?.focus.length ? overview.focus.map(window => <p key={window.start_at} className="py-2">{new Date(window.start_at).toLocaleString(undefined, { timeZone: zone, weekday: "short", hour: "numeric", minute: "2-digit" })}–{new Date(window.end_at).toLocaleTimeString(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" })}</p>) : <p className={styles.muted}>No verified focus windows to show.</p>}
      </SectionCard>
    </> : view === "library" ? <>
      <div><h2 className={styles.heading}>Recordings &amp; Notes</h2><p className={styles.muted}>Recent meetings from the past 30 days. File access is checked live.</p></div>
      <label className="relative"><Search aria-hidden className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input className="pl-10" type="search" aria-label="Search past meetings" placeholder="Search past meetings" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <SegmentedTabs variant="filter" ariaLabel="Recording and notes filters" value={filter} onValueChange={setFilter} options={[{ value: "all", label: "All" }, { value: "recording", label: "Recordings" }, { value: "notes", label: "Notes" }]} />
      {filter !== "all" ? <p className={styles.muted}>Filters include only files whose access was verified.</p> : null}
      {library && !library.complete ? <p role="status" className={styles.muted}>Some calendars or additional events could not be included. This list is incomplete.</p> : null}
      <SectionCard>{filtered.map(meeting => <button className={styles.row} type="button" key={`${meeting.calendar_id}:${meeting.id}`} ref={node => { const key = `${meeting.calendar_id}:${meeting.id}`; if (node) rowRefs.current.set(key, node); else rowRefs.current.delete(key); }} onClick={() => { lastSelectedId.current = `${meeting.calendar_id}:${meeting.id}`; setSelected(meeting); setDetailTab("notes"); setView("meeting"); }}><span className={styles.icon}><FileText className="size-5" /></span><span className={styles.copy}><strong>{meeting.title}</strong><span className={styles.muted}>{meeting.start?.dateTime ? new Date(meeting.start.dateTime).toLocaleString(undefined, { timeZone: zone, dateStyle: "medium", timeStyle: "short" }) : meeting.start?.date}</span><span className={styles.tags}>{meeting.artifact_kinds?.length ? meeting.artifact_kinds.map(kind => <span key={kind} className={styles.tag}>{kind === "recording" ? "Recording" : kind === "notes" ? "Notes" : "Transcript"}</span>) : <span className={styles.tag}>{meeting.artifact_status === "permission_required" ? "Permission required" : "Check meeting files"}</span>}</span></span><ChevronRight className="size-4" /></button>)}{!loading && !error && !filtered.length ? <p className={styles.muted}>{query || filter !== "all" ? "No matching meetings in this list." : "No linked meetings were returned for this period."}</p> : null}</SectionCard>
      {library?.next_page != null ? <Button variant="outline" disabled={loading} onClick={() => setPage(library.next_page!)}>Load more meetings</Button> : null}
      {library?.next_page != null && (query || filter !== "all") ? <p className={styles.muted}>Search and filters apply to loaded meetings. Load more to include older results.</p> : null}
    </> : <>
      <h2 className={styles.heading}>{selected?.title}</h2>
      {detail ? <>
        {detail.discovery !== "checked" ? <p role="status" className={styles.muted}>{detail.discovery === "permission_required" ? "Google Meet access is required to discover recordings, transcripts and smart notes. This Calendar connection does not grant it." : availability[detail.discovery]}</p> : null}
        <div className={styles.details}><SectionCard title="Recording">{artifacts.filter(item => item.kind === "recording").map(item => <Artifact key={item.file_id} item={item} />)}{!artifacts.some(item => item.kind === "recording") ? <p className={styles.muted}>No recording available from verified sources.</p> : null}</SectionCard>
        <SectionCard title="Meeting notes"><SegmentedTabs ariaLabel="Meeting assets" variant="filter" value={detailTab} onValueChange={setDetailTab} options={[{ value: "notes", label: "Notes" }, { value: "transcript", label: "Transcript" }]} />
          {artifacts.filter(item => item.kind === detailTab).map(item => <Artifact key={item.file_id} item={item} />)}
          {!artifacts.some(item => item.kind === detailTab) ? <p className="py-4 text-muted-foreground">{detailTab === "notes" ? "Notes" : "Transcript"} not available from verified sources.</p> : null}
          {detailTab === "notes" ? <div className="space-y-3 border-t pt-3"><div><h3 className="font-semibold">Decisions</h3><p className={styles.muted}>See the source notes above. No separate decision record was supplied.</p></div><div><h3 className="font-semibold">Follow-ups</h3><p className={styles.muted}>See the source notes above. No separate follow-up record was supplied.</p></div></div> : null}
        </SectionCard></div>
        <Button variant="outline" disabled={asking || !vaultOwnerToken || !artifacts.some(item => item.can_ask)} onClick={() => void ask()}><MessageSquare className="mr-2 size-4" />{asking ? "Checking source access…" : "Ask One about this meeting"}</Button>
        {!vaultOwnerToken ? <p className={styles.muted}>Unlock your vault in One to use meeting context in your conversation.</p> : null}
      </> : null}
    </>}
  </div>;
}
