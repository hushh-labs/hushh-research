"use client";

import { getAuthSessionGeneration, snapshotValidatedAuthSessionOwner, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { followupResourceKey, followupSnapshot, saveFollowupSnapshot, clearFollowupSnapshot } from "@/lib/calendar/calendar-followup-resource";
import presentationStyles from "./calendar-presentation.module.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink } from "@/components/icons";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { CalendarFollowupRow } from "./calendar-followup-row";
import styles from "./calendar-insights.module.css";
import { PaginatedListFooter } from "@/components/app-ui/paginated-list-footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/lib/morphy-ux/ui/surface-primitives";
import {
  SYNCED_NOTICE, coverageNotice, dueText, followupErrorText, gmailMessageUrl, isActive, rememberSyncedNotice, reminderText, rowSummary,
  primaryRequest, shortDate, syncedNoticeSeen,
} from "@/lib/calendar/calendar-followup-presentation";
import { bookingInstant } from "@/lib/calendar/calendar-booking-time";
import { MeetingReview, meetingStatus } from "@/components/calendar/calendar-followup-meeting-review";
import { initializeFollowupMonitor, rebindFollowupMonitor, scanWhilePending } from "@/lib/calendar/calendar-followup-sync";
import { FollowupRequestError, CalendarFollowupsService, type FollowupConversation, type FollowupDetail, type FollowupList, type FollowupRequest, type FollowupStatus, type FollowupView } from "@/lib/services/calendar-followups-service";

type Props = {
  userId: string; accountId: string; accountEmail: string; zone: string; expanded: boolean;
  getIdToken: () => Promise<string>;
  connectionRevision?: number; providerBinding?: string;
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
// A first scan reads the most recent month only; later passes are incremental.
const FIRST_SCAN_DAYS = 30;
// Each scan call does one bounded step on the server. While it reports more work
// the card keeps asking, so the first results arrive in seconds, not scheduler
// ticks. Capped, and it stops the moment the card goes away.
const CATCH_UP_MAX_CALLS = 20;
const FOLLOWUP_PAGE_SIZE = 15;
type ActiveView = Exclude<FollowupView, "history">;
const FOLLOWUP_VIEWS: Record<ActiveView, string> = {
  all: "All",
  upcoming: "Upcoming",
  overdue: "Overdue",
  snoozed: "Snoozed",
};

function isVisible(request: FollowupRequest) {
  return isActive(request) && request.bucket !== "history";
}

export function CalendarFollowups({ userId, accountId, accountEmail, zone, expanded, getIdToken, connectionRevision = 0, providerBinding = "", onViewAll, onConnectMail, onReviewMeeting, refreshRevision = 0, deepLinkRequestId, onDeepLinkHandled }: Props) {
  const resourceKey = followupResourceKey(userId, accountId, connectionRevision, providerBinding);
  const cached = followupSnapshot(resourceKey);
  const authGeneration = getAuthSessionGeneration();
  const [status, setStatus] = useState<FollowupStatus | null>(cached?.status ?? null);
  const [list, setList] = useState<FollowupList | null>(cached?.list ?? null);
  const [detail, setDetail] = useState<FollowupDetail | null>(null);
  const [removal, setRemoval] = useState<{ conversationId: string; requestId: string; title: string } | null>(null);
  const removeTrigger = useRef<HTMLButtonElement | null>(null);
  const removing = useRef(false);
  const [emailLinks, setEmailLinks] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedRequestId, setFocusedRequestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(!cached);
  const [loadingPage, setLoadingPage] = useState(false);
  const [pageOffset, setPageOffset] = useState(0);
  const [view, setView] = useState<ActiveView>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [reminderInput, setReminderInput] = useState("");
  const [reminderOpen, setReminderOpen] = useState<string | null>(null);
  const detailSeq = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const lifetime = useRef<AbortController | null>(null);
  const requestSeq = useRef(0);
  const activeReads = useRef(0);
  const hasVerifiedRows = useRef(Boolean(cached?.list.conversations.length));
  const pageOffsetRef = useRef(0);
  const viewRef = useRef<ActiveView>("all");
  const firstPageRef = useRef<FollowupList | null>(cached?.list ?? null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const tokenGetter = useRef(getIdToken); tokenGetter.current = getIdToken;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const handledIntent = useRef<string | null>(null);
  const focusedCard = useRef<HTMLDivElement | null>(null);
  const rebound = useRef(false);
  const clearPresentation = useCallback(() => {
    clearFollowupSnapshot(resourceKey);
    firstPageRef.current = null; hasVerifiedRows.current = false;
    detailSeq.current += 1; selectedIdRef.current = null;
    setStatus(null); setList(null); setDetail(null); setSelectedId(null); setEmailLinks({});
    setRemoval(null); setFocusedRequestId(null); setReminderInput(""); setReminderOpen(null);
  }, [resourceKey]);
  const clearRejectedAuthority = useCallback((failure: unknown) => {
    if (failure instanceof FollowupRequestError &&
        ([401, 403].includes(failure.status) || ["mail_grant_changed", "monitor_changed", "monitoring_off"].includes(failure.code))) {
      clearPresentation(); setLoading(false); setError(followupErrorText(failure));
    }
  }, [clearPresentation]);

  const currentIdToken = async () => {
    const controller = lifetime.current;
    const idToken = await tokenGetter.current();
    if (controller !== lifetime.current || controller?.signal.aborted || getAuthSessionGeneration() !== authGeneration || snapshotValidatedAuthSessionOwner()?.userId !== userId) {
      throw new DOMException("Follow-up session changed", "AbortError");
    }
    return idToken;
  };

  /** `quiet` refreshes in place: nothing flashes while the owner is reading. */
  const refresh = useCallback(async (signal?: AbortSignal, quiet = false) => {
    if (snapshotValidatedAuthSessionOwner()?.userId !== userId) return;
    const seq = ++requestSeq.current;
    activeReads.current += 1;
    // A refresh supersedes a pending page request, including its loading state.
    setLoadingPage(false);
    const alive = () => !signal?.aborted && requestSeq.current === seq && getAuthSessionGeneration() === authGeneration;
    if (!quiet) { setLoading(true); setError(""); }
    try {
      const idToken = await tokenGetter.current();
      if (!alive()) return;
      let nextStatus = await CalendarFollowupsService.status(userId, accountId, idToken, signal);
      if (!alive()) return;
      if (nextStatus.mail_connected && !nextStatus.monitoring_enabled) {
        if (!alive()) return;
        if (await initializeFollowupMonitor(userId, accountId, nextStatus, zone, idToken, signal)) {
          nextStatus = await CalendarFollowupsService.status(userId, accountId, idToken, signal);
          if (!alive()) return;
        }
      }
      if (nextStatus.mail_connected && nextStatus.monitoring_enabled && nextStatus.monitor_current === false) {
        await rebindFollowupMonitor(userId, accountId, nextStatus, zone, idToken, signal);
        if (!alive()) return;
        nextStatus = await CalendarFollowupsService.status(userId, accountId, idToken, signal);
        if (!alive()) return;
      }
      setStatus(nextStatus);
      if (!nextStatus.mail_connected || !nextStatus.monitoring_enabled) {
        clearPresentation(); setStatus(nextStatus); setLoading(false); return;
      }
      if (!alive()) return;
      let offset = pageOffsetRef.current;
      const selectedView = viewRef.current;
      let nextList = await CalendarFollowupsService.list(userId, accountId, idToken, signal, offset, selectedView);
      if (!alive()) return;
      if (offset > 0 && offset >= nextList.total_conversations) {
        offset = Math.max(0, Math.ceil(nextList.total_conversations / FOLLOWUP_PAGE_SIZE) - 1) * FOLLOWUP_PAGE_SIZE;
        nextList = await CalendarFollowupsService.list(userId, accountId, idToken, signal, offset, selectedView);
      }
      if (alive()) {
        if (offset === 0 && selectedView === "all") {
          firstPageRef.current = nextList;
          saveFollowupSnapshot(resourceKey, { status: nextStatus, list: nextList });
        }
        hasVerifiedRows.current = nextList.conversations.length > 0;
        pageOffsetRef.current = offset; setPageOffset(offset); setList(nextList); setLoading(false); setError("");
      }
    } catch (failure) {
      if (alive()) clearRejectedAuthority(failure);
      // Neither a background refresh nor a failed reload replaces items the owner
      // is already looking at with an error: the last verified list stays.
      if (alive() && !quiet) { if (!hasVerifiedRows.current) setError(followupErrorText(failure)); setLoading(false); }
    } finally { activeReads.current -= 1; }
  }, [userId, accountId, zone, resourceKey, authGeneration, clearRejectedAuthority, clearPresentation]);

  useEffect(() => {
    if (expanded) return;
    // Collapse also cancels a first Next request that has not applied its offset.
    if (loadingPage) { requestSeq.current += 1; setLoadingPage(false); }
    if (pageOffsetRef.current === 0 && viewRef.current === "all") return;
    pageOffsetRef.current = 0;
    viewRef.current = "all";
    setView("all");
    setPageOffset(0);
    setList(firstPageRef.current);
    void refresh(lifetime.current?.signal, true);
  }, [expanded, loadingPage, refresh]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void refresh(controller.signal, Boolean(followupSnapshot(resourceKey)));
    return () => { controller.abort(); requestSeq.current += 1; };
  }, [refresh, refreshRevision, connectionRevision, resourceKey]);

  const rebindMonitor = useCallback(async (current: FollowupStatus, signal?: AbortSignal) => {
    await rebindFollowupMonitor(userId, accountId, current, zone, await tokenGetter.current(), signal);
  }, [userId, accountId, zone]);

  /** The previous scan call reported more work: keep going, showing results as they land. */
  const continueScan = useCallback(async (signal?: AbortSignal) => {
    const finished = await scanWhilePending({
      userId, accountId, signal, maxCalls: CATCH_UP_MAX_CALLS - 1,
      getIdToken: () => tokenGetter.current(), refresh: () => refresh(signal, true),
    });
    if (!finished) lastCatchUp.delete(`${userId}:${accountId}`);
  }, [userId, accountId, refresh]);

  // Opening Insights shows what is already verified at once, then lets the
  // server continue in the background. It never blocks the card and never
  // repeats within the interval, so navigating around cannot trigger rescans.
  useEffect(() => {
    if (!status?.monitoring_enabled || !status.mail_connected) return;
    const signal = lifetime.current?.signal;
    if (signal?.aborted) return;
    if (!status.notifications_enabled && status.background_available) {
      // The Mail grant was renewed elsewhere, or reminders were left off: rebind
      // this account's monitor (reminders on) without asking again, keeping every
      // decision and the scan progress.
      if (rebound.current) return;
      rebound.current = true;
      void (async () => {
        try {
          await rebindMonitor(status, signal);
          await refresh(signal, true);
        } catch {
          // Nothing is shown for a background rebind, but a failure must not
          // block the next attempt: the owner may reconnect Mail in the meantime.
          rebound.current = false;
        }
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
        const result = await CalendarFollowupsService.scan(userId, accountId, await tokenGetter.current(), {}, signal);
        await refresh(signal, true);
        if (result?.state === "pending") await continueScan(signal);
      } catch { /* the scheduler continues without the page */ }
    })();
  }, [status, userId, accountId, zone, refresh, rebindMonitor, continueScan]);

  // While the first pass is still catching up, check back a few times so new
  // items appear without a manual refresh. Bounded; the scheduler does the work.
  const catchingUp = status?.monitoring_enabled && (status.coverage?.coverage === "catching_up" || status.scan_state === "pending");
  // "Catching up" ends with one plain "synced" line, shown the first time the
  // check is seen finished and not again on later loads. Catching up again (new
  // mail, a rule change) arms it for the next finish.
  const emailSynced = Boolean(status?.monitoring_enabled && status.scan_state === "complete" && status.coverage?.coverage === "complete");
  const [showSynced, setShowSynced] = useState(false);
  useEffect(() => {
    if (catchingUp) { rememberSyncedNotice(userId, accountId, false); setShowSynced(false); return; }
    if (!emailSynced || syncedNoticeSeen(userId, accountId)) return;
    rememberSyncedNotice(userId, accountId, true);
    setShowSynced(true);
  }, [catchingUp, emailSynced, userId, accountId]);
  useEffect(() => {
    if (!status?.monitoring_enabled) return;
    const wake = () => {
      if (document.visibilityState !== "hidden" && navigator.onLine !== false) {
        void refresh(lifetime.current?.signal, true);
      }
    };
    // Passive polling never supersedes an unfinished read or page selection.
    const timer = window.setInterval(() => {
      if (activeReads.current === 0) wake();
    }, catchingUp ? 5_000 : 60_000);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [catchingUp, status?.monitoring_enabled, refresh]);

  useEffect(() => subscribeAuthSessionGeneration(() => {
    lifetime.current?.abort(); requestSeq.current += 1; detailSeq.current += 1;
    clearPresentation();
  }), [clearPresentation]);

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
    const controller = new AbortController();
    void Promise.all(detail.requests.filter(isVisible).map(async request => {
      try {
        const link = await CalendarFollowupsService.sourceLink(userId, accountId, request.id, await tokenGetter.current(), controller.signal);
        return [request.id, gmailMessageUrl(accountEmail, link.gmail_message_id)] as const;
      } catch { return null; }
    })).then(entries => {
      if (!controller.signal.aborted) setEmailLinks(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry))));
    });
    return () => controller.abort();
  }, [detail, userId, accountId, accountEmail]);

  const openDetail = async (conversationId: string, from?: HTMLButtonElement | null, focusRequestId?: string): Promise<boolean> => {
    const operation = lifetime.current;
    const seq = ++detailSeq.current;
    selectedIdRef.current = conversationId;
    if (from) trigger.current = from;
    setSelectedId(conversationId); setDetail(null); setActionError(""); setEmailLinks({}); setReminderOpen(null);
    setFocusedRequestId(focusRequestId || null);
    try {
      const value = await CalendarFollowupsService.detail(userId, accountId, conversationId, await currentIdToken());
      if (operation !== lifetime.current || operation?.signal.aborted || getAuthSessionGeneration() !== authGeneration || detailSeq.current !== seq || selectedIdRef.current !== conversationId) return false;
      setDetail(value);
      return true;
    } catch (failure) { clearRejectedAuthority(failure); if (detailSeq.current === seq) setActionError(followupErrorText(failure)); return false; }
  };

  const act = async (request: FollowupRequest, action: "done" | "dismiss" | "snooze" | "set_reminder", reminderAt: string | null = null) => {
    setBusy(true); setActionError("");
    const operation = lifetime.current;
    const currentSelection = selectedIdRef.current;
    const seq = detailSeq.current;
    try {
      await CalendarFollowupsService.change(userId, accountId, request, action, reminderAt, await currentIdToken());
      clearFollowupSnapshot(resourceKey); firstPageRef.current = null;
      if (operation !== lifetime.current || operation?.signal.aborted || getAuthSessionGeneration() !== authGeneration) return;
      if (currentSelection) {
        const next = await CalendarFollowupsService.detail(userId, accountId, currentSelection, await currentIdToken());
        if (operation === lifetime.current && !operation?.signal.aborted && detailSeq.current === seq && selectedIdRef.current === currentSelection) setDetail(next);
      }
      await refresh(lifetime.current?.signal, true);
      setReminderInput(""); setReminderOpen(null);
    } catch (failure) { clearRejectedAuthority(failure); if (detailSeq.current === seq) setActionError(followupErrorText(failure)); }
    finally { setBusy(false); }
  };

  /**
   * One step for the owner. If Mail is not yet allowed for this exact account
   * it asks for that permission once; if it already is, nothing is asked again.
   */
  const turnOn = async () => {
    const operation = lifetime.current;
    setBusy(true); setError("");
    try {
      // Asking Google first would waste the owner's consent on a step that cannot finish.
      const latest = await CalendarFollowupsService.status(userId, accountId, await tokenGetter.current(), lifetime.current?.signal);
      if (operation !== lifetime.current || operation?.signal.aborted || getAuthSessionGeneration() !== authGeneration) return;
      let mailReady = latest.mail_connected;
      if (!mailReady) {
        if (!onConnectMail) return;
        mailReady = await onConnectMail(accountId);
        if (!mailReady) { setError("Email access was not allowed. Calendar works as before."); return; }
      }
      // Renewing access for an account that is already monitored keeps its
      // approved period, timing and reminders; only a first opt-in chooses them.
      const existing = status?.monitoring_enabled ? status : null;
      const historical = existing?.historical_start_at || new Date(Date.now() - FIRST_SCAN_DAYS * 86_400_000).toISOString();
      await CalendarFollowupsService.post("preferences", {
        user_id: userId, account_id: accountId, enabled: true,
        notifications_enabled: Boolean(status?.background_available),
        historical_start_at: historical,
        time_zone: existing?.time_zone || zone,
        reminder_lead_days: existing?.reminder_lead_days ?? 1, reminder_hour: existing?.reminder_hour ?? 9,
      }, await currentIdToken());
      lastCatchUp.delete(`${userId}:${accountId}`);
      // Connection is ready; inference continues without blocking its action.
      await refresh(lifetime.current?.signal);
    } catch (failure) { setError(followupErrorText(failure)); }
    finally { setBusy(false); }
  };

  /** The owner's explicit "check again": clears exhausted retries and runs now. */
  const checkAgain = async () => {
    setBusy(true); setError("");
    try {
      const first = await CalendarFollowupsService.scan(userId, accountId, await currentIdToken(), { retry: true });
      await refresh(lifetime.current?.signal, true);
      if (first?.state === "pending") void continueScan(lifetime.current?.signal).catch(() => undefined);
    } catch (failure) { setError(followupErrorText(failure)); }
    finally { setBusy(false); }
  };

  const reconnect = async () => {
    if (!onConnectMail) return;
    const operation = lifetime.current;
    setBusy(true); setError("");
    try {
      const latest = await CalendarFollowupsService.status(userId, accountId, await tokenGetter.current(), lifetime.current?.signal);
      if (operation !== lifetime.current || operation?.signal.aborted || getAuthSessionGeneration() !== authGeneration) return;
      const connected = latest.mail_connected || await onConnectMail(accountId);
      if (operation !== lifetime.current || operation?.signal.aborted || getAuthSessionGeneration() !== authGeneration) return;
      if (connected) {
        // Reconnecting changes the Mail grant, so point the monitor at it first;
        // otherwise this scan would still see the old one and ask to reconnect again.
        if (status?.monitoring_enabled) {
          try { await rebindMonitor(status, operation?.signal); } catch { /* the scan below reports what is still wrong */ }
        }
        await checkAgain();
      }
      else setError("Email access was not renewed. Your follow-ups stay as they are.");
    } catch (failure) { setError(followupErrorText(failure)); }
    finally { setBusy(false); }
  };

  const changePage = async (offset: number, targetView = view) => {
    if (!expanded || loadingPage || offset < 0 || (offset === pageOffset && targetView === view)) return;
    const seq = ++requestSeq.current;
    activeReads.current += 1;
    setLoadingPage(true); setError("");
    try {
      const page = await CalendarFollowupsService.list(
        userId, accountId, await currentIdToken(), lifetime.current?.signal, offset, targetView,
      );
      if (requestSeq.current !== seq || lifetime.current?.signal.aborted || !expandedRef.current) return;
      if (offset === 0 && targetView === "all") firstPageRef.current = page;
      viewRef.current = targetView;
      setView(targetView);
      pageOffsetRef.current = offset;
      setPageOffset(offset);
      setList(page);
    } catch (failure) { clearRejectedAuthority(failure); if (requestSeq.current === seq) setError(followupErrorText(failure)); }
    finally { activeReads.current -= 1; if (requestSeq.current === seq) setLoadingPage(false); }
  };

  const askRemove = (entry: FollowupConversation, from: HTMLButtonElement) => {
    const request = primaryRequest(entry);
    if (!request || removing.current) return;
    removeTrigger.current = from;
    setRemoval({ conversationId: entry.id, requestId: request.id, title: request.title });
  };

  const removeRequest = async () => {
    if (!removal || removing.current) return;
    removing.current = true;
    const operation = lifetime.current;
    setBusy(true);
    try {
      const idToken = await currentIdToken();
      const latest = await CalendarFollowupsService.detail(userId, accountId, removal.conversationId, idToken);
      if (operation !== lifetime.current || operation?.signal.aborted || getAuthSessionGeneration() !== authGeneration) return;
      const request = latest.requests.find(item => item.id === removal.requestId && isVisible(item));
      if (!request) {
        await refresh(lifetime.current?.signal);
        toast.info("This follow-up is no longer available.", { className: presentationStyles.toast });
        return;
      }
      await CalendarFollowupsService.change(userId, accountId, request, "dismiss", null, await currentIdToken());
      clearFollowupSnapshot(resourceKey); firstPageRef.current = null;
      if (lifetime.current?.signal.aborted) return;
      toast.success("Removed from Follow-ups", { className: presentationStyles.toast });
      await refresh(lifetime.current?.signal);
    } catch (failure) {
      if (!lifetime.current?.signal.aborted) toast.error(followupErrorText(failure), { className: presentationStyles.toast });
    } finally {
      removing.current = false;
      setBusy(false);
    }
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
    if (await openDetail(selectedId, undefined, focusedRequestId || deepLinkRequestId || undefined) && deepLinkRequestId) {
      finishDeepLink(deepLinkRequestId);
    }
  };

  useEffect(() => {
    if (!deepLinkRequestId || !status?.monitoring_enabled || !list || handledIntent.current === deepLinkRequestId) return;
    void (async () => {
      try {
        const target = await CalendarFollowupsService.resolve(
          userId, accountId, deepLinkRequestId, await currentIdToken(), lifetime.current?.signal,
        );
        if (lifetime.current?.signal.aborted) return;
        if (!await openDetail(target.conversationId, undefined, target.requestId)) return;
        finishDeepLink(deepLinkRequestId);
      } catch (failure) { setError(followupErrorText(failure)); }
    })();
  // openDetail is intentionally bound to this account; the component remounts on account switch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkRequestId, status?.monitoring_enabled, list]);

  const rows = expanded ? list?.conversations || [] : pageOffset === 0 && view === "all" ? (list?.conversations || []).slice(0, 2) : [];
  const viewCounts = list?.view_counts;
  const hasMoreViews = Boolean(viewCounts && (viewCounts.overdue || viewCounts.snoozed));
  const notice = status?.monitoring_enabled && !loading && !error ? coverageNotice(status.coverage ?? list?.coverage, true) : null;
  const needsMailChoice = Boolean(status && (!status.mail_connected || !status.monitoring_enabled));
  // Monitored before, access since removed: ask only to renew, never to choose again.
  const renewing = Boolean(status?.monitoring_enabled && !status.mail_connected);
  const card = <SectionCard title="Follow-ups" className={styles.followupCard}>
    <div className="min-w-0 space-y-2" aria-busy={loading}>
      {loading && (!status || (status.monitoring_enabled && !list)) ? <p className={styles.muted} role="status">Checking follow-ups…</p> : null}
      {needsMailChoice && renewing ? <div className={`${styles.muted} flex flex-wrap items-center justify-between gap-2`}>
        <span>Renew email access for {accountEmail}.</span>
        <Button size="compact" disabled={busy || !onConnectMail} onClick={() => void turnOn()}>Allow email access</Button>
      </div> : null}
      {needsMailChoice && !renewing ? <div className="space-y-3">
        <div className="space-y-1">
          <p className={presentationStyles.windowPrimary}>Find Calendar follow-ups in email.</p>
          <p className={styles.muted}>
            {status?.mail_connected
              ? `Checks the last ${FIRST_SCAN_DAYS} days of ${accountEmail}, then only new mail.`
              : `Allow your private agent to check ${accountEmail} for meetings and deadlines.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="compact" disabled={busy || (!status?.mail_connected && !onConnectMail)} onClick={() => void turnOn()}>{status?.mail_connected ? "Turn on" : "Allow email access"}</Button>
        </div>
        {status && !status.background_available ? <p className={styles.muted}>Background reminders are unavailable right now.</p> : null}
      </div> : null}
      {expanded && viewCounts ? <div className="flex flex-wrap gap-1" role="group" aria-label="Follow-up views">
        {(Object.keys(FOLLOWUP_VIEWS) as ActiveView[]).map(option => <Button
          key={option} size="compact" variant={view === option ? "default" : "ghost"}
          aria-pressed={view === option} disabled={loadingPage}
          onClick={() => void changePage(0, option)}
        >{FOLLOWUP_VIEWS[option]} ({viewCounts[option] ?? (option === "all" ? list?.total_conversations ?? 0 : 0)})</Button>)}
      </div> : null}
      {status?.monitoring_enabled && rows.length > 0 ? <div>
        {rows.map(entry => {
          const summary = rowSummary(entry, zone);
          if (!primaryRequest(entry)) return null;
          return <CalendarFollowupRow key={entry.id} title={summary.title} description={summary.detail} busy={busy}
            onReview={from => void openDetail(entry.id, from)}
            onKeep={() => toast.success("Kept in Follow-ups", { className: presentationStyles.toast })} onRemove={from => askRemove(entry, from)} />;
        })}
      </div> : null}
      {status?.monitoring_enabled && list?.total_conversations === 0 && status.coverage?.coverage !== "catching_up" && status.scan_state === "complete" && !loading ? <p className={styles.muted}>{view === "all" ? "No follow-ups right now." : viewCounts ? `No ${FOLLOWUP_VIEWS[view].toLowerCase()} follow-ups.` : "No pending follow-ups."}</p> : null}
      {notice ? <div className={notice.tone === "action" ? `${styles.muted} flex flex-wrap items-center justify-between gap-2` : styles.muted} role="status">
        <span>{notice.text}</span>
        {notice.action ? <Button size="compact" variant="outline" disabled={busy} onClick={() => void reconnect()}>Reconnect email</Button> : null}
      </div> : null}
      {!notice && showSynced && emailSynced ? <p className={styles.muted} role="status">{SYNCED_NOTICE}</p> : null}
      {error ? <div className="space-y-2">
        <p role="alert" className={`${presentationStyles.support} text-destructive`}>{error}</p>
        {error ? <Button size="compact" disabled={loading} onClick={() => void refresh(lifetime.current?.signal)}>Try again</Button> : null}
      </div> : null}
      <div className="flex items-center justify-between gap-2">
        {!expanded && hasMoreViews ? <span className={styles.muted}>{viewCounts?.overdue ?? 0} overdue · {viewCounts?.snoozed ?? 0} snoozed</span> : null}
        {!expanded && ((list?.total_conversations || 0) > 2 || hasMoreViews) ? <Button size="compact" variant="text" onClick={onViewAll}>View all</Button> : <span />}
      </div>
      {expanded && list ? <PaginatedListFooter
        page={Math.floor(pageOffset / FOLLOWUP_PAGE_SIZE) + 1}
        limit={FOLLOWUP_PAGE_SIZE}
        total={list.total_conversations}
        hasMore={list.next_offset != null}
        pending={loadingPage || loading}
        onPrevious={() => void changePage(Math.max(0, pageOffset - FOLLOWUP_PAGE_SIZE))}
        onNext={() => { if (list.next_offset != null) void changePage(list.next_offset); }}
        className={`px-0 ${presentationStyles.support}`}
        buttonSize="compact"
      /> : null}
    </div>
  </SectionCard>;

  const requests = detail?.requests.filter(isVisible) ?? [];
  return <>
    {card}
    <Dialog modal open={Boolean(selectedId)} onOpenChange={open => {
      if (open) return;
      detailSeq.current += 1;
      selectedIdRef.current = null;
      setSelectedId(null); setDetail(null); setFocusedRequestId(null);
    }}>
      <DialogContent data-connect-type-scale="page" className={`${styles.reviewDialog} ${presentationStyles.portal}`} srDescription="Review Calendar follow-ups"
        onCloseAutoFocus={event => {
          if (trigger.current?.isConnected) { event.preventDefault(); trigger.current.focus(); }
        }}>
        <DialogTitle className={styles.reviewTitle}>Follow-up{requests.length > 1 ? "s" : ""}</DialogTitle>
        <div className="min-w-0 space-y-3">
          {actionError ? <div><p role="alert" className={`${presentationStyles.support} text-destructive`}>{actionError}</p>{!detail && selectedId ? <Button size="compact" variant="outline" onClick={() => void retryDetail()}>Retry</Button> : null}</div> : null}
          {detail?.source_completeness === "partial" ? <p className={styles.muted}>Still checking this conversation.</p> : null}
          {requests.map((request, index) => {
            const href = emailLinks[request.id];
            const link = href && requests.findIndex(item => emailLinks[item.id] === href) === index ? href : null;
            return <div key={request.id} ref={request.id === focusedRequestId ? focusedCard : undefined} tabIndex={request.id === focusedRequestId ? -1 : undefined} className="min-w-0 space-y-2 rounded-lg border p-3">
              <div className={styles.reviewHeader}>
                <div className="min-w-0">
                  <h3 className={styles.followupTitle}>{request.title}</h3>
                  <p className={styles.muted}>{request.kind === "meeting" ? meetingStatus(request, zone) : dueText(request, zone)}</p>
                </div>
                {link ? <Button asChild variant="text" size="compact" className={styles.sourceAction}>
                  <a href={link} target="_blank" rel="noopener noreferrer" aria-label="Open original email"><span>Open original email</span><ExternalLink className="size-4" aria-hidden /></a>
                </Button> : null}
              </div>
              {request.kind !== "meeting" && request.linked_event ? <p className={styles.muted}>{request.linked_event[1]}{shortDate(request.linked_event[2]) ? ` · ${shortDate(request.linked_event[2])}` : ""}</p> : null}
              {request.kind === "meeting" ? <>
                {request.reminder_at ? <p className={styles.muted}>{reminderText(request, zone)}</p> : null}
                <MeetingReview key={request.id} request={request} zone={zone} busy={busy}
                onReview={(item, startAt, endAt, timeZone) => { onReviewMeeting(item, startAt, endAt, timeZone); setSelectedId(null); }} />
              </>
              : <>
                {request.reminder_at ? <p className={styles.muted}>{reminderText(request, zone)}</p> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="compact" disabled={busy} onClick={() => void act(request, "done")}>Mark done</Button>
                  <Button variant="text" size="compact" aria-expanded={reminderOpen === request.id}
                    onClick={() => setReminderOpen(reminderOpen === request.id ? null : request.id)}>Reminder</Button>
                </div>
                {reminderOpen === request.id ? <div className="flex min-w-0 flex-wrap items-end gap-2">
                  <label className="min-w-0 max-w-full">Reminder time<Input type="datetime-local" value={reminderInput} onChange={event => setReminderInput(event.target.value)} /></label>
                  <Button variant="outline" size="compact" disabled={busy || !reminderInput} onClick={() => {
                    try {
                      const [date, time] = reminderInput.split("T");
                      if (!date || !time) throw new Error("invalid reminder");
                      const reminder = bookingInstant(date, time, zone);
                      if (Date.parse(reminder) <= Date.now()) throw new Error("past reminder");
                      void act(request, "set_reminder", reminder);
                    } catch { setActionError("Choose a future reminder."); }
                  }}>Save reminder</Button>
                </div> : null}
              </>}
            </div>;
          })}
          {!detail && !actionError ? <p role="status" className={styles.muted}>Checking follow-up…</p> : null}
          {detail && !requests.length ? <p role="status" className={styles.muted}>No active follow-ups.</p> : null}
        </div>
      </DialogContent>
    </Dialog>
    <AlertDialog open={Boolean(removal)} onOpenChange={open => { if (!open) setRemoval(null); }}>
      <AlertDialogContent size="sm" className={`${styles.reviewDialog} ${presentationStyles.portal}`} data-connect-type-scale="page"
        onCloseAutoFocus={event => {
          if (removeTrigger.current?.isConnected) {
            event.preventDefault();
            removeTrigger.current.focus();
          }
        }}>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove follow-up?</AlertDialogTitle>
          <AlertDialogDescription>{removal?.title}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void removeRequest()}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
