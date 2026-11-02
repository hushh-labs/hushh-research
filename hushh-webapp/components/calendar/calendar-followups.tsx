"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Mail, MoreHorizontal } from "@/components/icons";
import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SectionCard } from "@/lib/morphy-ux/ui/surface-primitives";
import {
  coverageNotice, dueText, gmailMessageUrl, isActive, reminderText, rowSummary, senderName, shortDate,
} from "@/lib/calendar/calendar-followup-presentation";
import { bookingInstant } from "@/lib/calendar/calendar-booking-time";
import { MeetingReview, meetingStatus } from "@/components/calendar/calendar-followup-meeting-review";
import { clearMailChoice, hasMailChoice } from "@/lib/calendar/calendar-mail-choice";
import { CalendarFollowupsService, type FollowupDetail, type FollowupList, type FollowupRequest, type FollowupSource, type FollowupStatus } from "@/lib/services/calendar-followups-service";

type Props = {
  userId: string; accountId: string; accountEmail: string; zone: string; expanded: boolean;
  getIdToken: () => Promise<string>; getVaultOwnerToken: () => string | null;
  onViewAll: () => void; onConnectMail?: (accountId: string) => Promise<boolean>;
  onReviewMeeting: (request: FollowupRequest, startAt: string, endAt: string, timeZone: string) => void;
  refreshRevision?: number;
  deepLinkRequestId?: string | null;
  onDeepLinkHandled?: () => void;
};

// Opening Insights again soon must not repeat work. The server also refuses a
// scan that is not due, so this only avoids pointless round trips.
const CATCH_UP_INTERVAL_MS = 5 * 60_000;
const lastCatchUp = new Map<string, number>();
// A quiet progress check while the first scan is still running; bounded so a
// stuck account never polls forever.
const PROGRESS_CHECKS_MS = [15_000, 30_000, 60_000, 120_000];

function displayError(error: unknown): string {
  if (error instanceof Error && error.message === "FOLLOWUPS_DISABLED") return "Follow-ups are not available yet. Try again later.";
  if (error instanceof Error && error.message === "selected_mail_permission_required") return "Reconnect Mail for this account.";
  return "Follow-ups could not be checked. Try again.";
}

export function CalendarFollowups({ userId, accountId, accountEmail, zone, expanded, getIdToken, getVaultOwnerToken, onViewAll, onConnectMail, onReviewMeeting, refreshRevision = 0, deepLinkRequestId, onDeepLinkHandled }: Props) {
  const [status, setStatus] = useState<FollowupStatus | null>(null);
  const [list, setList] = useState<FollowupList | null>(null);
  const [detail, setDetail] = useState<FollowupDetail | null>(null);
  const [source, setSource] = useState<FollowupSource | null>(null);
  const [emailLinks, setEmailLinks] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedRequestId, setFocusedRequestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [historyDays, setHistoryDays] = useState(30);
  const [notify, setNotify] = useState<boolean | null>(null);
  const [reminderInput, setReminderInput] = useState("");
  const [reminderOpen, setReminderOpen] = useState<string | null>(null);
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
  const rebound = useRef(false);
  const progressChecks = useRef(0);
  const vaultAvailable = Boolean(getVaultOwnerToken());
  const chosenAtConnect = hasMailChoice(userId, accountId);
  const remind = notify ?? Boolean(status?.background_available);

  /** `quiet` refreshes in place: nothing flashes while the owner is reading. */
  const refresh = useCallback(async (signal?: AbortSignal, quiet = false) => {
    const seq = ++requestSeq.current;
    const alive = () => !signal?.aborted && requestSeq.current === seq;
    if (!quiet) { setLoading(true); setError(""); }
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
      if (!ownerToken) { if (!quiet) setError("Unlock One to view follow-ups."); setLoading(false); return; }
      const nextList = await CalendarFollowupsService.list(userId, accountId, idToken, ownerToken, signal);
      if (alive()) { setList(nextList); setLoading(false); setError(""); }
    } catch (failure) {
      // A background refresh never replaces verified items with an error.
      if (alive() && !quiet) { setError(displayError(failure)); setLoading(false); }
    }
  }, [userId, accountId]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void refresh(controller.signal);
    return () => { controller.abort(); requestSeq.current += 1; };
  }, [refresh, refreshRevision, vaultAvailable]);

  // Opening Insights shows what is already verified at once, then lets the
  // server continue in the background. It never blocks the card and never
  // repeats within the interval, so navigating around cannot trigger rescans.
  useEffect(() => {
    if (!status?.monitoring_enabled || !status.mail_connected) return;
    const ownerToken = ownerTokenGetter.current();
    const signal = lifetime.current?.signal;
    if (!ownerToken || signal?.aborted) return;
    if (status.monitor_current === false) {
      // The Mail grant was renewed elsewhere: rebind this account's monitor to
      // it without asking again, keeping every decision and the scan progress.
      if (rebound.current) return;
      rebound.current = true;
      void (async () => {
        try {
          await CalendarFollowupsService.post("preferences", {
            user_id: userId, account_id: accountId, enabled: true,
            notifications_enabled: status.notifications_enabled,
            historical_start_at: status.historical_start_at,
            time_zone: status.time_zone || zone,
            reminder_lead_days: status.reminder_lead_days ?? 1,
            reminder_hour: status.reminder_hour ?? 9,
          }, await tokenGetter.current(), ownerToken, signal);
          await refresh(signal, true);
        } catch { /* the next open tries again; nothing is shown for a background rebind */ }
      })();
      return;
    }
    if (status.coverage?.attention === "reconnect_mail") return;
    const key = `${userId}:${accountId}`;
    const last = lastCatchUp.get(key) ?? 0;
    if (Date.now() - last < CATCH_UP_INTERVAL_MS) return;
    lastCatchUp.set(key, Date.now());
    void (async () => {
      try {
        await CalendarFollowupsService.scan(userId, accountId, await tokenGetter.current(), ownerToken, {}, signal);
        await refresh(signal, true);
      } catch { /* the scheduler continues without the page */ }
    })();
  }, [status, userId, accountId, zone, refresh]);

  // While the first pass is still catching up, check back a few times so new
  // items appear without a manual refresh. Bounded; the scheduler does the work.
  const catchingUp = status?.monitoring_enabled && (status.coverage?.coverage === "catching_up" || status.scan_state === "pending");
  useEffect(() => {
    if (!catchingUp || progressChecks.current >= PROGRESS_CHECKS_MS.length) return;
    const timer = window.setTimeout(() => {
      progressChecks.current += 1;
      void refresh(lifetime.current?.signal, true);
    }, PROGRESS_CHECKS_MS[progressChecks.current]);
    return () => window.clearTimeout(timer);
  }, [catchingUp, status, list, refresh]);

  useEffect(() => {
    if (!focusedRequestId || !detail || !focusedCard.current) return;
    focusedCard.current.focus();
    focusedCard.current.scrollIntoView?.({ block: "nearest" });
  }, [detail, focusedRequestId]);

  // Links to the original Gmail message. The server returns only the message
  // reference, so this never reads mail; it just lets "Open original email" be
  // a normal link that browsers allow to open.
  useEffect(() => {
    if (!detail) return;
    const ownerToken = ownerTokenGetter.current();
    if (!ownerToken) return;
    let current = true;
    void Promise.all(detail.requests.map(async request => {
      try {
        const link = await CalendarFollowupsService.sourceLink(userId, accountId, request.id, await tokenGetter.current(), ownerToken);
        return [request.id, gmailMessageUrl(accountEmail, link.gmail_message_id)] as const;
      } catch { return null; }
    })).then(entries => {
      if (current) setEmailLinks(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry))));
    });
    return () => { current = false; };
  }, [detail, userId, accountId, accountEmail]);

  const selected = list?.conversations.find(entry => entry.id === selectedId) || null;
  const openDetail = async (conversationId: string, from?: HTMLButtonElement | null, focusRequestId?: string): Promise<boolean> => {
    const seq = ++detailSeq.current;
    sourceSeq.current += 1;
    selectedIdRef.current = conversationId;
    if (from) trigger.current = from;
    setSelectedId(conversationId); setDetail(null); setSource(null); setActionError(""); setEmailLinks({}); setReminderOpen(null);
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
      await refresh(lifetime.current?.signal, true);
      setReminderInput(""); setReminderOpen(null);
    } catch (failure) { if (detailSeq.current === seq) setActionError(displayError(failure)); }
    finally { setBusy(false); }
  };

  /**
   * One step for the owner. If Mail is not yet allowed for this exact account
   * it asks for that permission once; if it already is, nothing is asked again.
   */
  const turnOn = async () => {
    setBusy(true); setError("");
    try {
      let mailReady = Boolean(status?.mail_connected);
      if (!mailReady) {
        if (!onConnectMail) return;
        mailReady = await onConnectMail(accountId);
        if (!mailReady) { setError("Email access was not allowed. Calendar works as before."); return; }
      }
      const ownerToken = getVaultOwnerToken();
      if (!ownerToken) throw new Error("Unlock One before turning on email follow-ups.");
      // Renewing access for an account that is already monitored keeps its
      // approved period, timing and reminders; only a first opt-in chooses them.
      const existing = status?.monitoring_enabled ? status : null;
      const historical = existing?.historical_start_at || new Date(Date.now() - historyDays * 86_400_000).toISOString();
      await CalendarFollowupsService.post("preferences", {
        user_id: userId, account_id: accountId, enabled: true,
        notifications_enabled: existing ? existing.notifications_enabled : remind && Boolean(status?.background_available),
        historical_start_at: historical,
        time_zone: existing?.time_zone || zone,
        reminder_lead_days: existing?.reminder_lead_days ?? 1, reminder_hour: existing?.reminder_hour ?? 9,
      }, await getIdToken(), ownerToken);
      clearMailChoice();
      await CalendarFollowupsService.scan(userId, accountId, await getIdToken(), ownerToken);
      lastCatchUp.set(`${userId}:${accountId}`, Date.now());
      progressChecks.current = 0;
      await refresh(lifetime.current?.signal);
    } catch (failure) { setError(displayError(failure)); }
    finally { setBusy(false); }
  };

  /** The owner's explicit "check again": clears exhausted retries and runs now. */
  const checkAgain = async () => {
    setBusy(true); setError("");
    try {
      const ownerToken = getVaultOwnerToken();
      if (!ownerToken) throw new Error("Unlock One to check your email again.");
      await CalendarFollowupsService.scan(userId, accountId, await getIdToken(), ownerToken, { retry: true });
      progressChecks.current = 0;
      await refresh(lifetime.current?.signal, true);
    } catch (failure) { setError(displayError(failure)); }
    finally { setBusy(false); }
  };

  const reconnect = async () => {
    if (!onConnectMail) return;
    setBusy(true); setError("");
    try {
      const connected = await onConnectMail(accountId);
      if (connected) { await checkAgain(); }
      else setError("Email access was not renewed. Your follow-ups stay as they are.");
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
  const notice = status?.monitoring_enabled ? coverageNotice(status.coverage ?? list?.coverage) : null;
  const needsMailChoice = Boolean(status && (!status.mail_connected || !status.monitoring_enabled));
  // Monitored before, access since removed: ask only to renew, never to choose again.
  const renewing = Boolean(status?.monitoring_enabled && !status.mail_connected);
  const card = <SectionCard title="Follow-ups" description="From your email">
    <div className="space-y-2" aria-busy={loading}>
      {!status && loading ? <p className="text-sm text-muted-foreground" role="status">Checking this account…</p> : null}
      {needsMailChoice && renewing ? <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>Email access for {accountEmail} was removed. Your follow-ups stay as they are.</span>
        <Button size="compact" disabled={busy || !onConnectMail} onClick={() => void turnOn()}>Allow email access</Button>
      </div> : null}
      {needsMailChoice && !renewing ? <div className="space-y-3 text-sm">
        <div className="space-y-1">
          <p className="font-medium">Find meeting requests and reminders in my email.</p>
          <p className="text-muted-foreground">
            {status?.mail_connected
              ? `Your private agent already has read access to ${accountEmail}. Choose how far back to look.`
              : `This asks Google for one extra permission to read ${accountEmail}. Your private agent uses it only to find requests and proposed times. Calendar works the same without it.`}
            {chosenAtConnect ? " You chose this when connecting Calendar." : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">Look back<select className="min-h-10 rounded-md border bg-background px-2" value={historyDays} onChange={event => setHistoryDays(Number(event.target.value))} disabled={busy}>
            <option value={30}>30 days</option><option value={90}>90 days</option>
          </select></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={remind && Boolean(status?.background_available)} onChange={event => setNotify(event.target.checked)} disabled={busy || !status?.background_available} />Remind me</label>
          <Button size="compact" disabled={busy || (!status?.mail_connected && !onConnectMail)} onClick={() => void turnOn()}>{status?.mail_connected ? "Turn on" : "Allow email access"}</Button>
        </div>
        {status && !status.background_available ? <p className="text-muted-foreground">Background reminders are unavailable right now.</p> : null}
      </div> : null}
      {status?.monitoring_enabled && rows.map(entry => {
        const summary = rowSummary(entry, zone);
        return <div key={entry.id} className="flex min-w-0 items-center gap-3 border-t py-2 first:border-t-0">
          <Mail className="size-4 shrink-0 text-blue-600" aria-hidden />
          <div className="min-w-0 flex-1"><strong className="block line-clamp-2 break-words text-sm">{summary.title}</strong>
            <span className="block line-clamp-2 break-words text-xs text-muted-foreground">{summary.detail}</span>
            {summary.more ? <span className="block text-xs text-muted-foreground">{summary.more === 1 ? "1 more in this email" : `${summary.more} more in this email`}</span> : null}
          </div>
          <Button size="compact" variant="ghost" onClick={event => void openDetail(entry.id, event.currentTarget)} aria-label={`Review ${summary.title}`}>Review</Button>
        </div>;
      })}
      {status?.monitoring_enabled && list?.total_conversations === 0 && status.coverage?.coverage !== "catching_up" && status.scan_state === "complete" && !loading ? <p className="text-sm text-muted-foreground">No pending follow-ups.</p> : null}
      {notice ? <div className={notice.tone === "action" ? "flex flex-wrap items-center justify-between gap-2 text-sm" : "text-xs text-muted-foreground"} role="status">
        <span>{notice.text}</span>
        {notice.action ? <Button size="compact" variant="outline" disabled={busy} onClick={() => void (notice.action === "reconnect" ? reconnect() : checkAgain())}>{notice.action === "reconnect" ? "Reconnect email" : "Check again"}</Button> : null}
      </div> : null}
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      <div className="flex items-center justify-between gap-2">
        {!expanded && (list?.total_conversations || 0) > 2 ? <Button size="compact" variant="ghost" onClick={onViewAll}>View all</Button> : <span />}
        {status?.monitoring_enabled ? <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-touch" aria-label="Follow-up settings"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><DropdownMenuItem disabled={busy} onSelect={() => void checkAgain()}>Check email again</DropdownMenuItem><DropdownMenuItem onSelect={() => void disable()}>Turn off monitoring for this account</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}
      </div>
      {expanded && list?.next_offset != null ? <Button size="compact" variant="outline" disabled={loadingMore || loading} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</Button> : null}
    </div>
  </SectionCard>;

  return <>
    {card}
    <AdaptiveDetailSurface open={Boolean(selectedId)} onOpenChange={open => { if (!open) { detailSeq.current += 1; sourceSeq.current += 1; selectedIdRef.current = null; setSelectedId(null); setDetail(null); setSource(null); setFocusedRequestId(null); } }}
      onCloseAutoFocus={event => { if (trigger.current?.isConnected) { event.preventDefault(); trigger.current.focus(); } }}
      mobilePresentation="sheet" title={source?.subject || detail?.subject || selected?.subject || "Follow-up"}
      description={source ? `${senderName(source.sender)} · ${new Date(source.internal_date_ms).toLocaleDateString()}` : detail ? `${senderName(detail.sender)} · ${new Date(detail.latest_internal_date_ms).toLocaleDateString()}` : "Checking conversation…"}
      headerTextOverflow="wrap">
      <div className="space-y-4 text-sm">
        {actionError ? <div><p role="alert" className="text-red-600">{actionError}</p>{!detail && selectedId ? <Button size="compact" variant="outline" onClick={() => void retryDetail()}>Retry</Button> : null}</div> : null}
        {source ? <><Button variant="ghost" size="compact" onClick={() => setSource(null)}>Back to follow-up</Button>
          <p className="text-xs text-muted-foreground">Text of the email in {accountEmail}. Links and images are hidden here; use Open original email for the full message.</p>
          <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border p-3">{source.body}</div></> : detail ? <>
          {detail.source_completeness === "partial" ? <p className="text-xs text-muted-foreground">Still checking the rest of this conversation.</p> : null}
          {detail.requests.map((request, index) => {
            const closed = !isActive(request);
            // Several requests often come from one email: link it once, on the first.
            const link = detail.requests.findIndex(item => emailLinks[item.id] === emailLinks[request.id]) === index ? emailLinks[request.id] : undefined;
            return <div key={request.id} ref={request.id === focusedRequestId ? focusedCard : undefined} tabIndex={request.id === focusedRequestId ? -1 : undefined} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2"><div className="min-w-0"><strong className="break-words">{request.title}</strong>
                <p className="text-muted-foreground">{request.kind === "meeting" ? meetingStatus(request, zone) : dueText(request, zone)}</p>
                {request.kind !== "meeting" && request.linked_event ? <p className="text-muted-foreground">About: {request.linked_event[1]}{shortDate(request.linked_event[2]) ? ` · ${shortDate(request.linked_event[2])}` : ""}</p> : null}
              </div>
                {request.kind !== "meeting" && !closed ? <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-touch" aria-label={`More actions for ${request.title}`}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void act(request, "dismiss")}>Dismiss</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}
              </div>
              {request.source_excerpt ? <p className="line-clamp-3 whitespace-pre-wrap break-words text-muted-foreground">“{request.source_excerpt}”</p> : null}
              <div className="flex flex-wrap items-center gap-1">
                {link ? <Button asChild variant="ghost" size="compact"><a href={link} target="_blank" rel="noopener noreferrer">Open original email<ExternalLink className="ml-1 size-3" aria-hidden /></a></Button> : null}
                <Button variant="ghost" size="compact" disabled={busy} onClick={() => void openSource(request)}>View email text</Button>
              </div>
              {request.kind === "meeting" ? <>
                <MeetingReview key={request.id} request={request} zone={zone} busy={busy} onReview={(item, startAt, endAt, timeZone) => { onReviewMeeting(item, startAt, endAt, timeZone); setSelectedId(null); }} />
              </> : <>
                <p>{reminderText(request, zone)}</p>
                {!closed ? <div className="flex flex-wrap items-end gap-2"><Button size="compact" disabled={busy} onClick={() => void act(request, "done")}>Mark done</Button>
                  <Button variant="ghost" size="compact" disabled={busy} onClick={() => void act(request, "snooze", new Date(Date.now() + 86_400_000).toISOString())}>Snooze 1 day</Button>
                  <Button variant="ghost" size="compact" aria-expanded={reminderOpen === request.id} onClick={() => setReminderOpen(reminderOpen === request.id ? null : request.id)}>Change reminder</Button>
                  {reminderOpen === request.id ? <><label>Reminder<Input type="datetime-local" value={reminderInput} onChange={event => setReminderInput(event.target.value)} /></label>
                    <Button variant="outline" size="compact" disabled={busy || !reminderInput} onClick={() => {
                      try {
                        const [date, time] = reminderInput.split("T");
                        if (!date || !time) throw new Error("invalid reminder");
                        const reminder = bookingInstant(date, time, zone);
                        if (Date.parse(reminder) <= Date.now()) throw new Error("past reminder");
                        void act(request, "set_reminder", reminder);
                      } catch { setActionError("Choose a future reminder."); }
                    }}>Set reminder</Button></> : null}
                </div> : null}
              </>}
            </div>;
          })}
        </> : <p role="status">Checking follow-up…</p>}
      </div>
    </AdaptiveDetailSurface>
  </>;
}
