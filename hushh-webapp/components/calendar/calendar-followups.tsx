"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mail, MoreHorizontal } from "@/components/icons";
import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SectionCard } from "@/lib/morphy-ux/ui/surface-primitives";
import { bookingInstant, bookingLocalFields } from "@/lib/calendar/calendar-booking-time";
import { CalendarFollowupsService, type FollowupConversation, type FollowupDetail, type FollowupList, type FollowupRequest, type FollowupSource, type FollowupStatus } from "@/lib/services/calendar-followups-service";

type Props = {
  userId: string; accountId: string; accountEmail: string; zone: string; expanded: boolean;
  getIdToken: () => Promise<string>; getVaultOwnerToken: () => string | null;
  onViewAll: () => void; onConnectMail?: (accountId: string) => Promise<boolean>;
  onReviewMeeting: (request: FollowupRequest, startAt: string, endAt: string, timeZone: string) => void;
  refreshRevision?: number;
  deepLinkRequestId?: string | null;
  onDeepLinkHandled?: () => void;
};

function shortSender(value: string): string {
  const name = (value.split("<")[0] ?? "").trim().replace(/^"|"$/g, "");
  return name && !name.includes("@") ? name : value.match(/<([^>]+)>/)?.[1]?.split("@")[0] || value.split("@")[0] || value;
}
function dateLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }) : null;
}
function previewLine(entry: FollowupConversation): string {
  const requests = entry.preview_requests;
  const next = requests.find(item => item.kind !== "meeting") || requests[0];
  const meeting = requests.find(item => item.kind === "meeting" && item.id !== next?.id);
  const due = next?.original_due_wording || (next?.due_date ? `Due ${dateLabel(next.due_date)}` : null);
  const call = meeting?.proposed_date ? `Call proposed for ${dateLabel(meeting.proposed_date)}` : null;
  return [due, call].filter(Boolean).join(" · ") || "Needs review";
}
function displayError(error: unknown): string {
  if (error instanceof Error && error.message === "FOLLOWUPS_DISABLED") return "Follow-ups are not available yet. Try again later.";
  if (error instanceof Error && error.message === "selected_mail_permission_required") return "Reconnect Mail for this account.";
  return "Follow-ups could not be checked. Try again.";
}

function MeetingReview({ request, zone, busy, onReview }: {
  request: FollowupRequest; zone: string; busy: boolean;
  onReview: (request: FollowupRequest, startAt: string, endAt: string, timeZone: string) => void;
}) {
  const local = request.proposed_at ? bookingLocalFields(request.proposed_at, request.time_zone || zone) : null;
  const [date, setDate] = useState(local?.date || request.proposed_date || "");
  const [time, setTime] = useState(local?.time || "");
  const [duration, setDuration] = useState<"" | "15" | "30" | "60">(request.ambiguities.includes("duration") ? "" : "30");
  const [timeZone, setTimeZone] = useState(request.ambiguities.includes("time_zone") ? "" : request.time_zone || zone);
  const [error, setError] = useState("");
  if (request.state === "cancelled" || request.state === "dismissed" || request.booking_state === "booked") return null;
  return <>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <label>Date<Input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
      <label>Time<Input type="time" value={time} onChange={event => setTime(event.target.value)} /></label>
      <label>Duration<select className="h-10 w-full rounded-md border bg-background px-2" value={duration} onChange={event => setDuration(event.target.value as typeof duration)}><option value="">Choose</option><option value="15">15 min</option><option value="30">30 min</option><option value="60">60 min</option></select></label>
      <label>Time zone<select className="h-10 w-full rounded-md border bg-background px-2" value={timeZone} onChange={event => setTimeZone(event.target.value)}><option value="">Choose</option><option value={zone}>{zone}</option>{request.time_zone && request.time_zone !== zone ? <option value={request.time_zone}>{request.time_zone}</option> : null}{zone !== "UTC" && request.time_zone !== "UTC" ? <option value="UTC">UTC</option> : null}</select></label>
    </div>
    {error ? <p role="alert" className="text-red-600">{error}</p> : null}
    <Button size="compact" disabled={busy} onClick={() => {
      if (!date || !time || !duration || !timeZone) { setError("Choose the meeting date, time, duration and time zone first."); return; }
      try {
        const startAt = bookingInstant(date, time, timeZone);
        if (Date.parse(startAt) <= Date.now()) { setError("Choose a future meeting time."); return; }
        onReview(request, startAt, new Date(Date.parse(startAt) + Number(duration) * 60_000).toISOString(), timeZone);
      } catch { setError("Choose a valid meeting time."); }
    }}>Review meeting</Button>
  </>;
}

export function CalendarFollowups({ userId, accountId, accountEmail, zone, expanded, getIdToken, getVaultOwnerToken, onViewAll, onConnectMail, onReviewMeeting, refreshRevision = 0, deepLinkRequestId, onDeepLinkHandled }: Props) {
  const [status, setStatus] = useState<FollowupStatus | null>(null);
  const [list, setList] = useState<FollowupList | null>(null);
  const [detail, setDetail] = useState<FollowupDetail | null>(null);
  const [source, setSource] = useState<FollowupSource | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedRequestId, setFocusedRequestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [historyDays, setHistoryDays] = useState(30);
  const [notify, setNotify] = useState(false);
  const [reminderInput, setReminderInput] = useState("");
  const detailSeq = useRef(0);
  const sourceSeq = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const lifetime = useRef<AbortController | null>(null);
  const requestSeq = useRef(0);
  const tokenGetter = useRef(getIdToken); tokenGetter.current = getIdToken;
  const ownerTokenGetter = useRef(getVaultOwnerToken); ownerTokenGetter.current = getVaultOwnerToken;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const handledIntent = useRef<string | null>(null);
  const focusedCard = useRef<HTMLDivElement | null>(null);
  const vaultAvailable = Boolean(getVaultOwnerToken());

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const seq = ++requestSeq.current;
    const alive = () => !signal?.aborted && requestSeq.current === seq;
    setLoading(true); setError("");
    try {
      const idToken = await tokenGetter.current();
      if (!alive()) return;
      const nextStatus = await CalendarFollowupsService.status(userId, accountId, idToken, signal);
      if (!alive()) return;
      setStatus(nextStatus);
      if (!nextStatus.mail_connected || !nextStatus.monitoring_enabled) {
        setList(null); setLoading(false); return;
      }
      const ownerToken = ownerTokenGetter.current();
      if (!ownerToken) { setError("Unlock One to view follow-ups."); setLoading(false); return; }
      const nextList = await CalendarFollowupsService.list(userId, accountId, idToken, ownerToken, signal);
      if (alive()) { setList(nextList); setLoading(false); }
    } catch (failure) {
      if (alive()) { setError(displayError(failure)); setLoading(false); }
    }
  }, [userId, accountId]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void refresh(controller.signal);
    return () => { controller.abort(); requestSeq.current += 1; };
  }, [refresh, refreshRevision, vaultAvailable]);

  useEffect(() => {
    if (!focusedRequestId || !detail || !focusedCard.current) return;
    focusedCard.current.focus();
    focusedCard.current.scrollIntoView?.({ block: "nearest" });
  }, [detail, focusedRequestId]);

  const selected = list?.conversations.find(entry => entry.id === selectedId) || null;
  const openDetail = async (conversationId: string, from?: HTMLButtonElement | null, focusRequestId?: string): Promise<boolean> => {
    const seq = ++detailSeq.current;
    sourceSeq.current += 1;
    selectedIdRef.current = conversationId;
    if (from) trigger.current = from;
    setSelectedId(conversationId); setDetail(null); setSource(null); setActionError("");
    setFocusedRequestId(focusRequestId || null);
    try {
      const ownerToken = getVaultOwnerToken();
      if (!ownerToken) throw new Error("Unlock One to review this follow-up.");
      const value = await CalendarFollowupsService.detail(userId, accountId, conversationId, await getIdToken(), ownerToken);
      if (lifetime.current?.signal.aborted || detailSeq.current !== seq || selectedIdRef.current !== conversationId) return false;
      setDetail(value);
      return true;
    } catch (failure) { if (detailSeq.current === seq) setActionError(displayError(failure)); return false; }
  };

  const act = async (request: FollowupRequest, action: "done" | "dismiss" | "snooze" | "set_reminder", reminderAt: string | null = null) => {
    setBusy(true); setActionError("");
    const currentSelection = selectedIdRef.current;
    const seq = detailSeq.current;
    try {
      const ownerToken = getVaultOwnerToken();
      if (!ownerToken) throw new Error("Unlock One to change this follow-up.");
      await CalendarFollowupsService.change(userId, accountId, request, action, reminderAt, await getIdToken(), ownerToken);
      if (currentSelection) {
        const next = await CalendarFollowupsService.detail(userId, accountId, currentSelection, await getIdToken(), ownerToken);
        if (detailSeq.current === seq && selectedIdRef.current === currentSelection) setDetail(next);
      }
      await refresh(lifetime.current?.signal);
      setReminderInput("");
    } catch (failure) { if (detailSeq.current === seq) setActionError(displayError(failure)); }
    finally { setBusy(false); }
  };

  const enable = async () => {
    setBusy(true); setError("");
    try {
      const ownerToken = getVaultOwnerToken();
      if (!ownerToken) throw new Error("Unlock One before enabling Mail monitoring.");
      const historical = new Date(Date.now() - historyDays * 86_400_000).toISOString();
      await CalendarFollowupsService.post("preferences", {
        user_id: userId, account_id: accountId, enabled: true,
        notifications_enabled: notify, historical_start_at: historical,
        time_zone: zone, reminder_lead_days: 1, reminder_hour: 9,
      }, await getIdToken(), ownerToken);
      await CalendarFollowupsService.post("scan", { user_id: userId, account_id: accountId }, await getIdToken(), ownerToken);
      await refresh(lifetime.current?.signal);
    } catch (failure) { setError(displayError(failure)); }
    finally { setBusy(false); }
  };

  const retryScan = async () => {
    setBusy(true); setError("");
    try {
      const ownerToken = getVaultOwnerToken();
      if (!ownerToken) throw new Error("Unlock One to retry Mail scanning.");
      await CalendarFollowupsService.post("scan", { user_id: userId, account_id: accountId }, await getIdToken(), ownerToken);
      await refresh(lifetime.current?.signal);
    } catch (failure) { setError(displayError(failure)); }
    finally { setBusy(false); }
  };

  const loadMore = async () => {
    const offset = list?.next_offset;
    if (offset == null || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true); setError("");
    try {
      const ownerToken = getVaultOwnerToken();
      if (!ownerToken) throw new Error("Unlock One to view follow-ups.");
      const page = await CalendarFollowupsService.list(
        userId, accountId, await getIdToken(), ownerToken, lifetime.current?.signal, offset,
      );
      if (requestSeq.current !== seq || lifetime.current?.signal.aborted) return;
      setList(current => {
        if (!current || current.next_offset !== offset) return current;
        const ids = new Set(current.conversations.map(entry => entry.id));
        return { ...page, conversations: [
          ...current.conversations,
          ...page.conversations.filter(entry => !ids.has(entry.id)),
        ] };
      });
    } catch (failure) { if (requestSeq.current === seq) setError(displayError(failure)); }
    finally { setLoadingMore(false); }
  };

  const disable = async () => {
    setBusy(true); setError("");
    try {
      const ownerToken = getVaultOwnerToken();
      if (!ownerToken) throw new Error("Unlock One to turn off monitoring.");
      await CalendarFollowupsService.post("preferences", {
        user_id: userId, account_id: accountId, enabled: false,
      }, await getIdToken(), ownerToken);
      setSelectedId(null); setDetail(null); setSource(null);
      await refresh(lifetime.current?.signal);
    } catch (failure) { setError(displayError(failure)); }
    finally { setBusy(false); }
  };

  const connect = async () => {
    if (!onConnectMail) return;
    setBusy(true); setError("");
    try {
      const connected = await onConnectMail(accountId);
      if (connected) await refresh(lifetime.current?.signal);
      else setError("Mail was not connected for this Calendar account.");
    } catch (failure) { setError(displayError(failure)); }
    finally { setBusy(false); }
  };

  const openSource = async (request: FollowupRequest) => {
    const seq = ++sourceSeq.current;
    const currentSelection = selectedIdRef.current;
    setBusy(true); setActionError("");
    try {
      const ownerToken = getVaultOwnerToken();
      if (!ownerToken) throw new Error("Unlock One to open this email.");
      const value = await CalendarFollowupsService.source(userId, accountId, request.id, await getIdToken(), ownerToken);
      if (!lifetime.current?.signal.aborted && sourceSeq.current === seq && selectedIdRef.current === currentSelection) setSource(value);
    } catch (failure) { if (sourceSeq.current === seq) setActionError(displayError(failure)); }
    finally { setBusy(false); }
  };

  const finishDeepLink = (requestId: string) => {
    handledIntent.current = requestId;
    const url = new URL(window.location.href);
    url.searchParams.delete("followupAccount"); url.searchParams.delete("followupRequest");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    onDeepLinkHandled?.();
  };

  const retryDetail = async () => {
    if (!selectedId) return;
    if (await openDetail(selectedId, undefined, deepLinkRequestId || undefined) && deepLinkRequestId) {
      finishDeepLink(deepLinkRequestId);
    }
  };

  useEffect(() => {
    if (!deepLinkRequestId || !status?.monitoring_enabled || !list || handledIntent.current === deepLinkRequestId) return;
    void (async () => {
      try {
        const ownerToken = getVaultOwnerToken();
        if (!ownerToken) throw new Error("Unlock One to open this follow-up.");
        const conversationId = await CalendarFollowupsService.resolve(
          userId, accountId, deepLinkRequestId, await getIdToken(), ownerToken, lifetime.current?.signal,
        );
        if (lifetime.current?.signal.aborted) return;
        if (!await openDetail(conversationId, undefined, deepLinkRequestId)) return;
        finishDeepLink(deepLinkRequestId);
      } catch (failure) { setError(displayError(failure)); }
    })();
  // openDetail is intentionally bound to this account; the component remounts on account switch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkRequestId, status?.monitoring_enabled, list]);

  const rows = expanded ? list?.conversations || [] : (list?.conversations || []).slice(0, 2);
  const card = <SectionCard title={expanded ? "Follow-ups" : "Follow-ups"} description="From your email">
    <div className="space-y-2" aria-busy={loading}>
      {!status && loading ? <p className="text-sm text-muted-foreground" role="status">Checking this Mail account…</p> : null}
      {status && !status.mail_connected ? <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>Mail is not connected for {accountEmail}.</span>
        <Button size="compact" variant="outline" disabled={busy} onClick={() => void connect()}>Connect Mail</Button>
      </div> : null}
      {status?.mail_connected && !status.monitoring_enabled ? <div className="space-y-2 text-sm">
        <p>Check this account’s email for requests and proposed meetings.</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">Scan<select className="min-h-10 rounded-md border bg-background px-2" value={historyDays} onChange={event => setHistoryDays(Number(event.target.value))} disabled={busy}>
            <option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option>
          </select></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={notify} onChange={event => setNotify(event.target.checked)} disabled={busy || !status.background_available} />Remind me</label>
          <Button size="compact" disabled={busy} onClick={() => void enable()}>Enable</Button>
        </div>
        {!status.background_available ? <p className="text-muted-foreground">Background reminders are unavailable right now.</p> : null}
      </div> : null}
      {status?.monitoring_enabled && rows.map(entry => {
        const next = entry.preview_requests.find(item => item.kind !== "meeting") || entry.preview_requests[0];
        return <div key={entry.id} className="flex min-w-0 items-center gap-3 border-t py-2 first:border-t-0">
          <Mail className="size-4 shrink-0 text-blue-600" aria-hidden />
          <div className="min-w-0 flex-1"><strong className="block truncate text-sm">{next?.title || entry.subject}</strong>
            <span className="block truncate text-xs text-muted-foreground">{previewLine(entry)} · {shortSender(entry.sender)}</span>
            {entry.source_completeness === "partial" ? <span className="text-xs text-amber-700">Source check incomplete</span> : null}
          </div>
          <Button size="compact" variant="ghost" onClick={event => void openDetail(entry.id, event.currentTarget)} aria-label={`Review ${next?.title || entry.subject}`}>Review</Button>
        </div>;
      })}
      {status?.monitoring_enabled && list?.total_conversations === 0 && status.scan_state === "complete" && !loading ? <p className="text-sm text-muted-foreground">No pending follow-ups.</p> : null}
      {status?.monitoring_enabled && (status.scan_state === "partial" || list?.incomplete_source_count) ? <p className="text-xs text-amber-700">Some email could not be checked completely. Retry to continue.</p> : null}
      {status?.monitoring_enabled && status.scan_state === "pending" && !rows.length ? <p className="text-sm text-muted-foreground">Checking your email…</p> : null}
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      <div className="flex items-center justify-between gap-2">
        {!expanded && (list?.total_conversations || 0) > 2 ? <Button size="compact" variant="ghost" onClick={onViewAll}>View all</Button> : <span />}
        {status?.monitoring_enabled ? <div className="flex items-center gap-1"><Button size="compact" variant="ghost" disabled={loading || busy} onClick={() => void retryScan()}>Retry</Button>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-touch" aria-label="Follow-up settings"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void disable()}>Turn off monitoring for this account</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div> : null}
      </div>
      {expanded && list?.next_offset != null ? <Button size="compact" variant="outline" disabled={loadingMore || loading} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</Button> : null}
    </div>
  </SectionCard>;

  return <>
    {card}
    <AdaptiveDetailSurface open={Boolean(selectedId)} onOpenChange={open => { if (!open) { detailSeq.current += 1; sourceSeq.current += 1; selectedIdRef.current = null; setSelectedId(null); setDetail(null); setSource(null); setFocusedRequestId(null); } }}
      onCloseAutoFocus={event => { if (trigger.current?.isConnected) { event.preventDefault(); trigger.current.focus(); } }}
      mobilePresentation="sheet" title={source?.subject || detail?.subject || selected?.subject || "Follow-up"}
      description={source ? `${source.sender} · ${new Date(source.internal_date_ms).toLocaleDateString()}` : detail ? `${detail.sender} · ${new Date(detail.latest_internal_date_ms).toLocaleDateString()}` : "Checking conversation…"}
      headerTextOverflow="wrap">
      <div className="space-y-4 text-sm">
        {actionError ? <div><p role="alert" className="text-red-600">{actionError}</p>{!detail && selectedId ? <Button size="compact" variant="outline" onClick={() => void retryDetail()}>Retry</Button> : null}</div> : null}
        {source ? <><Button variant="ghost" size="compact" onClick={() => setSource(null)}>Back to follow-up</Button>
          <p className="text-xs text-muted-foreground">Source email in {accountEmail}</p>
          <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border p-3">{source.body}</div></> : detail ? <>
          {detail.source_completeness === "partial" ? <p className="text-amber-700">Some messages in this conversation could not be checked completely.</p> : null}
          {detail.requests.map(request => <div key={request.id} ref={request.id === focusedRequestId ? focusedCard : undefined} tabIndex={request.id === focusedRequestId ? -1 : undefined} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-start justify-between gap-2"><div className="min-w-0"><strong className="break-words">{request.title}</strong>
              <p className="text-muted-foreground">{request.original_due_wording || (request.proposed_date ? `Proposed for ${dateLabel(request.proposed_date)}` : "Date needs review")}</p></div>
              {request.kind !== "meeting" && request.state !== "done" && request.state !== "cancelled" ? <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-touch" aria-label={`More actions for ${request.title}`}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void act(request, "dismiss")}>Dismiss</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}
            </div>
            <p className="line-clamp-3 whitespace-pre-wrap break-words text-muted-foreground">“{request.source_excerpt}”</p>
            <Button variant="ghost" size="compact" disabled={busy} onClick={() => void openSource(request)}>Open email</Button>
            {request.kind === "meeting" ? <>
              <p className="font-medium">{request.booking_state === "booked" ? "Booked" : "Not booked"}</p>
              <MeetingReview key={request.id} request={request} zone={zone} busy={busy} onReview={(item, startAt, endAt, timeZone) => { onReviewMeeting(item, startAt, endAt, timeZone); setSelectedId(null); }} />
            </> : <>
              <p>{request.state === "done" ? "Completed" : request.reminder_at ? `Reminder: ${new Date(request.reminder_at).toLocaleString(undefined, { timeZone: zone, dateStyle: "medium", timeStyle: "short" })}` : "No reminder set"}</p>
              {request.state !== "done" && request.state !== "cancelled" && request.state !== "dismissed" ? <div className="flex flex-wrap items-end gap-2"><Button size="compact" disabled={busy} onClick={() => void act(request, "done")}>Mark done</Button>
                <label>Reminder<Input type="datetime-local" value={reminderInput} onChange={event => setReminderInput(event.target.value)} /></label>
                <Button variant="outline" size="compact" disabled={busy || !reminderInput} onClick={() => {
                  try {
                    const [date, time] = reminderInput.split("T");
                    if (!date || !time) throw new Error("invalid reminder");
                    const reminder = bookingInstant(date, time, zone);
                    if (Date.parse(reminder) <= Date.now()) throw new Error("past reminder");
                    void act(request, "set_reminder", reminder);
                  } catch { setActionError("Choose a future reminder."); }
                }}>Set reminder</Button>
                <Button variant="ghost" size="compact" disabled={busy} onClick={() => void act(request, "snooze", new Date(Date.now() + 86_400_000).toISOString())}>Snooze 1 day</Button></div> : null}
            </>}
          </div>)}
        </> : <p role="status">Checking follow-up…</p>}
      </div>
    </AdaptiveDetailSurface>
  </>;
}
