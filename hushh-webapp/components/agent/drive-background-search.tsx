"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useCoarseClock, usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { Button } from "@/lib/morphy-ux/button";
import { Card } from "@/lib/morphy-ux/card";
import { ChevronDown, ChevronRight, X } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ConnectorBrandMark } from "@/components/agent/connector-brand-mark";
import { HelperText } from "@/components/app-ui/typography";
import { dismissDriveSharingCard, isDriveSharingCardDismissed } from "@/lib/agent/drive-sharing-card-preferences";
import { DriveSearchError, DriveSearchService, type DriveSearchResults, type DriveSearchSelection, type DriveSearchStatus } from "@/lib/services/drive-search-service";
import { DriveSharingError, DriveSharingService, type DriveBulkShareFilePage, type DriveBulkShareView } from "@/lib/services/drive-sharing-service";

const CHANGED = "hushh:drive-searches-changed";
const ACTIVE = new Set<DriveSearchStatus["status"]>(["queued", "running"]);
const READ_BLOCKED = new Set(["connect_required", "reconnect_required", "connection_changed", "permission_denied", "search_expired", "search_not_found", "not_found"]);
type OwnerProps = { getToken: () => string | null };
export type SelectedDriveSearchFile = DriveSearchSelection & { name: string };
type SearchSelectionProps = { onUseInChat?: (selection: SelectedDriveSearchFile) => void };

/** Every async path rechecks the vault generation before publishing or acting. */
function useOwnerGuard(getToken: OwnerProps["getToken"]) {
  const alive = useRef(false);
  const epoch = useRef(snapshotVaultSessionEpoch());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return useCallback(() => {
    const token = getToken();
    const guard = () => {
      if (!alive.current || !isVaultSessionEpochCurrent(epoch.current) || !token || getToken() !== token)
        throw new DriveSearchError("session_changed");
    };
    return { token: token ?? "", guard };
  }, [getToken]);
}

function failure(cause: unknown): string {
  const code = cause instanceof DriveSearchError ? cause.code : "request_failed";
  if (["connect_required", "reconnect_required", "connection_changed"].includes(code))
    return "Review your Drive connection, then search again.";
  if (["active_search_exists", "search_active", "search_conflict", "search_in_progress"].includes(code)) return "A Drive search is already running. See Drive searches.";
  return "Couldn’t load this search. Try again.";
}

/** A semantic chat proposal opens only the review; no permission changes on mount. */
export function DriveBulkShareCard({ searchJobId, clientRequestId }: { searchJobId: string; clientRequestId: string }) {
  const { user } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  if (!user || !isVaultUnlocked) return <HelperText role="status">Unlock One to review Drive sharing.</HelperText>;
  return <DriveBulkShareReview key={`${user.uid}:${searchJobId}:${snapshotVaultSessionEpoch()}`}
    searchJobId={searchJobId} clientRequestId={clientRequestId} autoPrepare getToken={getVaultOwnerToken} />;
}

export function ContinueDriveSearch({ query }: { query: string }) {
  const { user } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  if (!user || !isVaultUnlocked) return null;
  return <ContinueUnlocked key={`${user.uid}:${snapshotVaultSessionEpoch()}:${query}`} query={query} getToken={getVaultOwnerToken} />;
}
function ContinueUnlocked({ query, getToken }: OwnerProps & { query: string }) {
  const owner = useOwnerGuard(getToken);
  const requestId = useRef<string | null>(null);
  const busy = useRef(false);
  const [phase, setPhase] = useState<"idle" | "starting" | "started">("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const target = useRef<HTMLParagraphElement>(null);
  const start = async () => {
    if (busy.current) return;
    busy.current = true;
    const { token, guard } = owner();
    setPhase("starting");
    setNotice(null);
    try {
      requestId.current ??= crypto.randomUUID();
      await DriveSearchService.create(token, query, requestId.current, guard);
      guard();
      setPhase("started");
      setNotice("Searching in the background. See Drive searches.");
      window.dispatchEvent(new Event(CHANGED));
    } catch (cause) {
      try { guard(); } catch { return; }
      setPhase("idle");
      setNotice(failure(cause));
      // A lost create response is retried with the same key; list also recovers
      // a committed job without starting another search.
      window.dispatchEvent(new Event(CHANGED));
    } finally {
      busy.current = false;
      target.current?.focus();
    }
  };
  return <div className="space-y-2">
    <HelperText>Matches keep loading after you leave. Stop anytime.</HelperText>
    <Button type="button" variant="muted" size="compact" disabled={phase !== "idle"} onClick={() => void start()}>
      {phase === "starting" ? "Starting search…" : phase === "started" ? "Search started" : "Continue in background"}
    </Button>
    <HelperText ref={target} role="status" tabIndex={-1}>{notice}</HelperText>
  </div>;
}

/** Reopening chat restores owner jobs from the server, not local storage. */
export function DriveBackgroundSearches({ onUseInChat }: SearchSelectionProps = {}) {
  const { user } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  if (!user || !isVaultUnlocked) return null;
  return <RecentSearches key={`${user.uid}:${snapshotVaultSessionEpoch()}`} ownerId={user.uid} getToken={getVaultOwnerToken} onUseInChat={onUseInChat} />;
}
export function DriveRecentSharing({ presentation = "card", active = true, onNeedsReviewChange }: {
  presentation?: "card" | "sidebar"; active?: boolean; onNeedsReviewChange?: (count: number) => void;
} = {}) {
  const { user } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  if (!user || !isVaultUnlocked) return null;
  return <RecentSearches key={`${user.uid}:${snapshotVaultSessionEpoch()}`} ownerId={user.uid} getToken={getVaultOwnerToken}
    sharingOnly sidebar={presentation === "sidebar"} active={active} onNeedsReviewChange={onNeedsReviewChange} />;
}
function RecentSearches({ ownerId, getToken, onUseInChat, sharingOnly = false, sidebar = false, active = true, onNeedsReviewChange }: OwnerProps &
  SearchSelectionProps & { ownerId: string; sharingOnly?: boolean; sidebar?: boolean; active?: boolean; onNeedsReviewChange?: (count: number) => void }) {
  const owner = useOwnerGuard(getToken);
  const serial = useRef(0);
  const bulkSerial = useRef(0);
  const [jobs, setJobs] = useState<DriveSearchStatus[]>([]);
  const [bulkShares, setBulkShares] = useState<DriveBulkShareView[]>([]);
  const [error, setError] = useState(false);
  const [bulkError, setBulkError] = useState(false);
  const seen = useRef(false);
  const seenBulk = useRef(false);
  const dismissed = useRef(new Set<string>());
  const [bulkErrorDismissed, setBulkErrorDismissed] = useState(false);
  const [selectedShareId, setSelectedShareId] = useState<string | null>(null);
  const [showAllShares, setShowAllShares] = useState(false);
  const selectedSidebar = useRef<HTMLElement | null>(null);
  const dismissingDetail = useRef(false);
  const load = useCallback(async () => {
    const ticket = ++serial.current;
    const { token, guard: checkOwner } = owner();
    const guard = () => { checkOwner(); if (serial.current !== ticket) throw new DriveSearchError("superseded"); };
    try {
      const next = await DriveSearchService.recent(token, guard);
      guard();
      seen.current ||= next.length > 0;
      setJobs(next.filter(job => Date.parse(job.expiresAt) > Date.now()));
      setError(false);
    } catch {
      try { guard(); } catch { return; }
      setJobs([]);
      setError(seen.current);
    }
  }, [owner]);
  const loadBulk = useCallback(async () => {
    const ticket = ++bulkSerial.current;
    const { token, guard: checkOwner } = owner();
    const guard = () => { checkOwner(); if (bulkSerial.current !== ticket) throw new DriveSharingError("superseded"); };
    try {
      const next = await DriveSharingService.recentBulkShares(token, guard);
      guard();
      seenBulk.current ||= next.length > 0;
      const visible = await Promise.all(next.map(async share => ({ share,
        hidden: dismissed.current.has(share.shareId) || await isDriveSharingCardDismissed(ownerId, share.shareId),
      })));
      guard();
      setBulkShares(visible.filter(({ share, hidden }) => !hidden && !dismissed.current.has(share.shareId) && Date.parse(share.expiresAt) > Date.now())
        .map(({ share }) => share));
      setBulkError(false);
    } catch {
      try { guard(); } catch { return; }
      setBulkShares([]); setBulkError(seenBulk.current);
    }
  }, [owner, ownerId]);
  const dismiss = (share: DriveBulkShareView, returnFocusToComposer = true) => {
    const { guard } = owner();
    try { guard(); } catch { return; }
    dismissed.current.add(share.shareId);
    setBulkShares(items => items.filter(item => item.shareId !== share.shareId));
    void dismissDriveSharingCard(ownerId, share.shareId, share.expiresAt, () => {
      try { guard(); return true; } catch { return false; }
    });
    // Return focus to the task the person was doing; no share is stopped.
    if (returnFocusToComposer)
      document.querySelector<HTMLTextAreaElement>("[data-agent-chat-composer-form] textarea")?.focus();
  };
  const invalidate = useCallback(() => { ++serial.current; ++bulkSerial.current; }, []);
  useEffect(() => {
    // The history drawer stays mounted for its slide animation. Its Drive
    // activity must not fetch or poll while the drawer is closed.
    if (!active) return invalidate;
    if (!sharingOnly) void load();
    void loadBulk();
    const changed = () => { if (!sharingOnly) { seen.current = true; void load(); } void loadBulk(); };
    window.addEventListener(CHANGED, changed);
    return () => { invalidate(); window.removeEventListener(CHANGED, changed); };
  }, [active, load, loadBulk, invalidate, sharingOnly]);
  useEffect(() => {
    if (sidebar) onNeedsReviewChange?.(bulkShares.filter(share => share.status === "review_ready" && share.canApprove).length);
  }, [bulkShares, onNeedsReviewChange, sidebar]);
  useEffect(() => () => { if (sidebar) onNeedsReviewChange?.(0); }, [onNeedsReviewChange, sidebar]);
  usePeriodicTask(`drive-recent-sharing:${ownerId}`, bulkShares.some(share => BULK_ACTIVE.has(share.status)) ? 10_000 : 45_000,
    loadBulk, { enabled: active && sidebar && !selectedShareId });
  const detached = sharingOnly ? bulkShares : bulkShares.filter(share => !jobs.some(job => job.jobId === share.searchJobId));
  if (sidebar) {
    if (!detached.length && (!bulkError || bulkErrorDismissed)) return null;
    const selected = detached.find(share => share.shareId === selectedShareId);
    const ordered = [...detached].sort((a, b) => Number(b.status === "review_ready") - Number(a.status === "review_ready"));
    const visible = showAllShares ? ordered : ordered.slice(0, 3);
    const restoreSidebarFocus = () => {
      const sidebarElement = selectedSidebar.current;
      if (!sidebarElement?.isConnected) return;
      const target = sidebarElement.querySelector<HTMLButtonElement>("[data-drive-sharing-row]") ??
        sidebarElement.querySelector<HTMLInputElement>('input[aria-label="Search chats"]');
      target?.focus({ preventScroll: true });
    };
    return <section className="mb-2 border-b border-[color:var(--one-chat-divider)] pb-2" aria-label="Drive sharing activity">
      <h3 className="px-3 pb-1 pt-1.5 text-[13.5px] font-normal text-[color:var(--one-chat-meta)]">Drive sharing</h3>
      {bulkError && !bulkErrorDismissed ? <div className="px-3 py-2 text-xs text-muted-foreground">
        <p>Couldn’t load Drive activity.</p>
        <button type="button" className="min-h-11 font-medium text-foreground underline underline-offset-2"
          onClick={() => void loadBulk()}>Try again</button>
      </div> : null}
      <div role="list" aria-label="Recent Drive sharing" className="space-y-0.5">{visible.map(share => {
        const available = share.counts.shared + share.counts.alreadyShared;
        const active = BULK_ACTIVE.has(share.status);
        const needsAttention = share.counts.skipped + share.counts.failed + share.counts.needsReview + share.counts.unknown > 0;
        const allAvailable = share.status === "completed" && share.counts.total > 0 && available === share.counts.total;
        const title = share.status === "review_ready" ? "Review files" : active ? "Sharing files" :
          share.status === "stopped" ? "Sharing stopped" : share.status === "failed" ? "Sharing failed" :
            needsAttention ? "Needs attention" : allAvailable ? "Files are ready" : "Sharing incomplete";
        const summary = share.status === "review_ready" ? `${share.fileCount.toLocaleString()} files to review` :
          `${available.toLocaleString()} of ${share.counts.total.toLocaleString()} available`;
        return <div role="listitem" key={share.shareId}><button type="button" data-drive-sharing-row
          className="flex min-h-14 w-full items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-left text-foreground hover:bg-[color:var(--one-chat-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/60"
          aria-label={`${title}. ${summary}. View details`}
          onClick={event => { selectedSidebar.current = event.currentTarget.closest("[data-agent-history-sidebar]"); setSelectedShareId(share.shareId); }}>
          <ConnectorBrandMark brand="drive" />
          <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium leading-5">{title}</span>
            <span className="block truncate text-[12px] leading-4 text-[color:var(--one-chat-meta)]">{summary}</span></span>
          {active ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent animate-pulse motion-reduce:animate-none" /> : null}
          <ChevronRight className="size-4 shrink-0 text-[color:var(--one-chat-meta)]" aria-hidden="true" />
        </button></div>;
      })}</div>
      {ordered.length > 3 ? <button type="button" className="min-h-11 px-3 text-[12px] font-medium text-[color:var(--one-chat-meta)] hover:text-foreground"
        onClick={() => setShowAllShares(value => !value)}>{showAllShares ? "Show fewer updates" : `Show all ${ordered.length} updates`}</button> : null}
      <Dialog modal open={!!selected} onOpenChange={open => { if (!open) { setSelectedShareId(null); void loadBulk(); } }}>
        <DialogContent className="gap-3 p-4 sm:max-w-xl sm:p-5" srDescription="Google Drive sharing progress and available actions."
          onCloseAutoFocus={event => { if (dismissingDetail.current) { event.preventDefault(); dismissingDetail.current = false; restoreSidebarFocus(); } }}>
          <DialogTitle>Drive sharing</DialogTitle>
          {selected ? <>
            <DriveBulkShareReview key={selected.shareId} searchJobId={selected.searchJobId} initial={selected} getToken={getToken} />
            <Button type="button" variant="muted" size="compact" className="self-start"
              onClick={() => { dismissingDetail.current = true; setSelectedShareId(null); dismiss(selected, false);
                requestAnimationFrame(restoreSidebarFocus); }}
              title="Hide this update without changing file access">Hide this update</Button>
          </> : null}
        </DialogContent>
      </Dialog>
    </section>;
  }
  if (!jobs.length && !error && !detached.length && (!bulkError || bulkErrorDismissed)) return null;
  return <div className={`mx-auto w-full max-w-4xl space-y-2 ${sharingOnly ? "max-h-[min(24rem,40dvh)] overflow-y-auto p-1" : ""}`}>
    {!sharingOnly && (jobs.length || error) ? <details open className="rounded-2xl bg-foreground/[0.035] px-4 py-2 text-sm" aria-label="Drive searches">
    <summary className="min-h-11 cursor-pointer content-center font-medium">Recent Drive searches{jobs.length ? ` · ${jobs.length}` : ""}</summary>
    {error ? <div className="space-y-2 py-2"><HelperText role="status">Couldn’t load your searches.</HelperText>
      <Button variant="muted" size="compact" onClick={() => void load()}>Try again</Button></div> : null}
    <div className="max-h-96 space-y-4 overflow-y-auto py-2">
      {jobs.map(job => <DriveBackgroundSearchCard key={job.jobId} initial={job} getToken={getToken} onUseInChat={onUseInChat} />)}
    </div>
  </details> : null}
    {bulkError && !bulkErrorDismissed ? <Card preset="compact" effect="fill" className="p-4"><div className="flex items-center justify-between gap-3">
      <div className="space-y-2"><HelperText role="status">Couldn’t load sharing progress.</HelperText>
        <Button type="button" variant="muted" size="compact" onClick={() => void loadBulk()}>Try again</Button></div>
      <DriveSharingClose onClick={() => setBulkErrorDismissed(true)} />
    </div></Card> : null}
    <div className="space-y-3">{detached.map(share =>
      <DriveBulkShareReview key={share.shareId} searchJobId={share.searchJobId} initial={share} getToken={getToken}
        onDismiss={() => dismiss(share)} />)}</div>
  </div>;
}

function DriveSharingClose({ onClick }: { onClick: () => void }) {
  return <ShellActionSurface onClick={onClick} aria-label="Close Drive sharing card"
    title="Hide this card without changing file access."
    className="h-11 w-11 !border-transparent !bg-transparent !shadow-none text-destructive hover:!bg-destructive/10 hover:!text-destructive">
    <X className="h-5 w-5" aria-hidden="true" />
  </ShellActionSurface>;
}

export function DriveBackgroundSearchCard({ initial, getToken, onUseInChat }: OwnerProps & SearchSelectionProps & { initial: DriveSearchStatus }) {
  const owner = useOwnerGuard(getToken);
  const [view, setView] = useState<DriveSearchStatus | null>(initial);
  const [page, setPage] = useState<DriveSearchResults | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failures, setFailures] = useState(0);
  const [canCancel, setCanCancel] = useState(initial.canStop);
  const [pollBlocked, setPollBlocked] = useState(false);
  const serial = useRef(0);
  const activeRead = useRef(false);
  const mutating = useRef(false);
  const latestRevision = useRef(initial.revision);
  // Keep only the authenticated mutation receipt when result access is lost.
  // File names, links and pages are always cleared on a failed read.
  const stoppedReceipt = useRef<DriveSearchStatus | null>(null);
  const target = useRef<HTMLParagraphElement>(null);
  const now = useCoarseClock(1000);
  // The shared clock pauses in a hidden tab; use wall time on any resumed render.
  const currentTime = Math.max(now, Date.now());
  const expired = currentTime >= Date.parse(initial.expiresAt);

  const load = useCallback(async (nextCursor: string | null, decision = false) => {
    if (mutating.current || (!decision && activeRead.current)) return;
    const ticket = ++serial.current;
    activeRead.current = true;
    if (decision) { setLoading(true); setPage(null); }
    const { token, guard: checkOwner } = owner();
    const guard = () => { checkOwner(); if (ticket !== serial.current) throw new DriveSearchError("superseded"); };
    try {
      const next = await DriveSearchService.get(token, initial.jobId, guard);
      guard();
      if (next.revision < latestRevision.current) throw new DriveSearchError("search_changed");
      setCanCancel(next.canStop);
      const results = await DriveSearchService.results(token, initial.jobId, guard, nextCursor);
      guard();
      // Reads racing an append may be newer, never older than the status read.
      if (next.revision < latestRevision.current || results.revision < next.revision)
        throw new DriveSearchError("search_changed");
      latestRevision.current = Math.max(next.revision, results.revision);
      setView(next);
      setPage(results);
      setNotice(null);
      setFailures(0);
      setPollBlocked(false);
    } catch (cause) {
      try { guard(); } catch { return; }
      setView(stoppedReceipt.current);
      setPage(null);
      setNotice(stoppedReceipt.current ? "Couldn’t load saved results." : failure(cause));
      setFailures(value => value + 1);
      setPollBlocked(cause instanceof DriveSearchError && READ_BLOCKED.has(cause.code));
    } finally {
      if (ticket === serial.current) { activeRead.current = false; setLoading(false); }
    }
  }, [initial.jobId, owner]);
  const invalidate = useCallback(() => { ++serial.current; activeRead.current = false; }, []);
  useEffect(() => { void load(cursor, true); return invalidate; }, [cursor, load, invalidate]);
  usePeriodicTask(`drive-search:${initial.jobId}`, Math.min(10_000, 2000 * 2 ** Math.min(failures, 3)),
    () => load(cursor), { enabled: !expired && !stopping && !pollBlocked && !stoppedReceipt.current && (!view || ACTIVE.has(view.status)) });

  const stop = async () => {
    if (mutating.current) return;
    mutating.current = true;
    const ticket = ++serial.current; // A mutation supersedes every in-flight poll.
    activeRead.current = false;
    setStopping(true);
    setLoading(false);
    const { token, guard: checkOwner } = owner();
    const guard = () => { checkOwner(); if (ticket !== serial.current) throw new DriveSearchError("superseded"); };
    try {
      const next = await DriveSearchService.stop(token, initial.jobId, guard);
      guard();
      latestRevision.current = Math.max(latestRevision.current, next.revision);
      stoppedReceipt.current = next;
      setCanCancel(next.canStop);
      setView(next);
      setPage(null);
      setNotice(null);
      const results = await DriveSearchService.results(token, initial.jobId, guard, cursor);
      guard();
      if (results.revision < next.revision) throw new DriveSearchError("search_changed");
      latestRevision.current = Math.max(next.revision, results.revision);
      setView(next);
      setPage(results);
      setNotice(null);
    } catch (cause) {
      try { guard(); } catch { return; }
      setView(stoppedReceipt.current); setPage(null);
      setNotice(stoppedReceipt.current ? "Couldn’t load saved results." : failure(cause));
    } finally {
      if (ticket === serial.current) { mutating.current = false; setStopping(false); target.current?.focus(); }
    }
  };
  if (expired) return null;
  const matched = Math.max(view?.matched ?? 0, page?.matched ?? 0);
  const state = view?.status;
  const label = state && ACTIVE.has(state) ? "Searching" : state === "completed" ? "Search complete" :
    state === "stopped" ? "Stopped" : state === "limited" ? "Search limit reached" : state === "failed" ? "Search interrupted" : "Search unavailable";
  const end = view && !ACTIVE.has(view.status) ? Date.parse(view.updatedAt) : currentTime;
  const elapsed = Math.max(0, Math.floor((end - Date.parse(initial.createdAt)) / 1000));
  const remainingMinutes = Math.max(1, Math.ceil((Date.parse(initial.expiresAt) - currentTime) / 60_000));
  const expiresIn = remainingMinutes < 60 ? `${remainingMinutes}m` : `${Math.ceil(remainingMinutes / 60)}h`;
  return <section className="space-y-2" aria-label="Background Drive search">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <HelperText ref={target} role="status" tabIndex={-1}>{!stoppedReceipt.current && notice ? notice : `${label} · ${matched.toLocaleString()} found`}</HelperText>
      <div className="flex items-center gap-2"><HelperText>{elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`} elapsed · Expires in {expiresIn}</HelperText>
        {(canCancel || stopping) ? <Button type="button" variant="muted" size="compact" disabled={stopping} onClick={() => void stop()}>{stopping ? "Stopping…" : "Stop"}</Button> : null}
      </div>
    </div>
    {stoppedReceipt.current && notice ? <HelperText>{notice}</HelperText> : null}
    {view?.incompleteSearch && !ACTIVE.has(view.status) ? <HelperText>Some matches may be missing.</HelperText> : null}
    {view?.status === "failed" ? <HelperText>Couldn’t finish searching. Try the search again in chat.</HelperText> : null}
    {state === "completed" && !view?.incompleteSearch && matched > 0 && page ?
      <DriveBulkShareReview searchJobId={initial.jobId} getToken={getToken} /> : null}
    <div aria-label="Found Drive files" aria-busy={loading}>
      {page?.files.length ? <ul className="space-y-1">{page.files.map(file => <li key={file.id} className="min-w-0 break-words py-1">
        {file.openUrl ? <a className="text-primary underline underline-offset-4" href={file.openUrl} target="_blank" rel="noopener noreferrer">{file.name}</a> : file.name}
        {onUseInChat ? <Button type="button" variant="muted" size="compact" className="ml-2" aria-label={`Use ${file.name} in chat`}
          onClick={() => { try { owner().guard(); onUseInChat({ jobId: initial.jobId, position: file.position, name: file.name }); } catch { /* No stale-owner handoff. */ } }}>
          Use in chat
        </Button> : null}
      </li>)}</ul> : null}
    </div>
    {previous.length > 0 || page?.nextCursor ? <div className="flex gap-2">
      <Button type="button" variant="muted" size="compact" disabled={loading || stopping || !previous.length}
        onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious(value => value.slice(0, -1)); }}>Previous</Button>
      <Button type="button" variant="muted" size="compact" disabled={loading || stopping || !page?.nextCursor}
        onClick={() => { setPrevious(value => [...value, cursor]); setCursor(page?.nextCursor ?? null); }}>Next 25</Button>
    </div> : null}
    {notice ? <Button type="button" variant="muted" size="compact" disabled={loading || stopping} onClick={() => void load(cursor, true)}>Try again</Button> : null}
  </section>;
}

const BULK_ACTIVE = new Set<DriveBulkShareView["status"]>(["queued", "running"]);
const BULK_EXCLUSION_COPY: Record<string, string> = {
  not_connected: "not connected with you", contacts: "connected through contacts",
  circle: "connected through a circle", imported: "an imported connection",
  unavailable: "unavailable", no_google_account: "needs a verified email",
  no_verified_email: "needs a verified email", limit: "outside this share's recipient limit",
};

/** Reviewing a saved result set never grants permission; only the Share tap does. */
function DriveBulkShareReview({ searchJobId, getToken, initial = null, clientRequestId = searchJobId,
  autoPrepare = false, onDismiss }: OwnerProps & { searchJobId: string; initial?: DriveBulkShareView | null;
  clientRequestId?: string; autoPrepare?: boolean; onDismiss?: () => void }) {
  const owner = useOwnerGuard(getToken);
  const [view, setView] = useState<DriveBulkShareView | null>(initial);
  const [page, setPage] = useState<DriveBulkShareFilePage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [loading, setLoading] = useState(!initial);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [action, setAction] = useState<"preparing" | "approving" | "stopping" | "retrying" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const statusSerial = useRef(0);
  const previewSerial = useRef(0);
  const busy = useRef(false);
  const autoPrepared = useRef(false);
  const target = useRef<HTMLParagraphElement>(null);

  const load = useCallback(async () => {
    if (busy.current) return;
    const ticket = ++statusSerial.current;
    const { token, guard: checkOwner } = owner();
    const guard = () => { checkOwner(); if (ticket !== statusSerial.current) throw new DriveSharingError("superseded"); };
    setLoading(true);
    try {
      const shares = initial
        ? [await DriveSharingService.bulkShareStatus(token, initial.shareId, guard)]
        : await DriveSharingService.bulkSharesForSearch(token, searchJobId, guard);
      guard();
      let current = shares.filter(item => Date.parse(item.expiresAt) > Date.now())
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
      if (!current && autoPrepare && !autoPrepared.current) {
        autoPrepared.current = true;
        setAction("preparing");
        current = await DriveSharingService.prepareBulkShare(token, searchJobId, guard, clientRequestId);
        guard();
        setAction(null);
      }
      setView(current);
      setError(null);
    } catch {
      try { guard(); } catch { return; }
      // Never leave a former review, recipient list, or count on a failed read.
      setView(null); setPage(null); setAction(null); setError("Couldn’t load sharing status. Try again.");
    } finally {
      if (ticket === statusSerial.current) setLoading(false);
    }
  }, [owner, searchJobId, autoPrepare, clientRequestId, initial]);

  useEffect(() => {
    const statusSerialRef = statusSerial;
    const previewSerialRef = previewSerial;
    void load();
    return () => { ++statusSerialRef.current; ++previewSerialRef.current; };
  }, [load]);
  usePeriodicTask(`drive-bulk-share:${searchJobId}`, 5000, load,
    { enabled: !!view && BULK_ACTIVE.has(view.status) && !action && !error });

  useEffect(() => {
    const previewSerialRef = previewSerial;
    const shareId = view?.status === "review_ready" ? view.shareId : null;
    if (!shareId) { setPage(null); setPreviewError(false); return; }
    const ticket = ++previewSerial.current;
    const { token, guard: checkOwner } = owner();
    const guard = () => { checkOwner(); if (ticket !== previewSerial.current) throw new DriveSharingError("superseded"); };
    setPage(null); setPreviewLoading(true); setPreviewError(false);
    void DriveSharingService.bulkShareFiles(token, shareId, guard, cursor).then(next => {
      guard(); setPage(next);
    }).catch(() => {
      try { guard(); } catch { return; }
      setPage(null); setPreviewError(true);
    }).finally(() => { if (ticket === previewSerial.current) setPreviewLoading(false); });
    return () => { ++previewSerialRef.current; };
  }, [view?.shareId, view?.status, cursor, owner]);

  const mutate = async (kind: "preparing" | "approving" | "stopping" | "retrying") => {
    if (busy.current) return;
    if (kind === "approving" && (!view?.canApprove || view.status !== "review_ready" || !page || previewError)) return;
    if (kind === "stopping" && (!view?.canStop || !BULK_ACTIVE.has(view.status))) return;
    if (kind === "retrying" && (!view?.canRetry || !view.retryableCount || !["partial", "failed"].includes(view.status))) return;
    busy.current = true;
    ++statusSerial.current;
    setAction(kind); setError(null);
    const { token, guard } = owner();
    let completed: DriveBulkShareView | null = null;
    try {
      const next = kind === "preparing"
        ? await DriveSharingService.prepareBulkShare(token, searchJobId, guard, clientRequestId)
        : kind === "approving"
          ? await DriveSharingService.approveBulkShare(token, view!, guard)
          : kind === "retrying"
            ? await DriveSharingService.retryBulkShare(token, view!, guard)
            : await DriveSharingService.stopBulkShare(token, view!.shareId, guard);
      guard();
      if (next.searchJobId !== searchJobId) throw new DriveSharingError("invalid_response");
      completed = next;
    } catch (cause) {
      try { guard(); } catch { return; }
      setView(null); setPage(null);
      const code = cause instanceof DriveSharingError ? cause.code : "request_failed";
      setError(code === "review_changed" || code === "source_changed" || code === "recipient_changed"
        ? "Sharing details changed. Load the review again." : "Couldn’t finish that. Check sharing status and try again.");
    } finally {
      busy.current = false;
      try { guard(); } catch { return; }
      setAction(null);
      if (completed) {
        try {
          guard(); setView(completed); setCursor(null); setPrevious([]); setPage(null);
        } catch { /* Owner changed while settling; publish nothing. */ }
      }
      target.current?.focus();
    }
  };

  if (loading && !view && !error) return <HelperText>Checking sharing…</HelperText>;
  if (error) return <Card preset="compact" effect="fill" className="p-4"><div className="flex items-start justify-between gap-3">
    <div className="space-y-2"><HelperText ref={target} role="status" tabIndex={-1}>{error}</HelperText>
      <Button type="button" variant="muted" size="compact" onClick={() => void load()}>Try again</Button></div>
    {onDismiss ? <DriveSharingClose onClick={onDismiss} /> : null}
  </div></Card>;
  if (!view) return <Button type="button" variant="muted" size="compact" disabled={!!action}
    onClick={() => void mutate("preparing")}>{action === "preparing" ? "Preparing review…" : "Review sharing"}</Button>;

  const { counts } = view;
  const complete = !BULK_ACTIVE.has(view.status) && view.status !== "review_ready";
  const available = counts.shared + counts.alreadyShared;
  const attention = counts.skipped + counts.failed + counts.needsReview + counts.unknown;
  const allAvailable = complete && counts.total > 0 && available === counts.total;
  const title = view.status === "review_ready" ? "Review Drive sharing" : allAvailable ? "Files are ready" :
    view.status === "stopped" ? "Sharing stopped" : view.status === "failed" ? "Sharing failed" :
      complete ? "Sharing incomplete" : "Sharing files";
  const summary = view.status === "review_ready"
    ? `Review ${view.fileCount.toLocaleString()} files with ${view.recipientCount} ${view.recipientCount === 1 ? "person" : "people"}`
    : `${available.toLocaleString()} of ${counts.total.toLocaleString()} ${view.recipientCount === 1 ? "files available" : "file shares complete"}`;
  return <Card preset="compact" effect="fill" role="region" className="min-w-0 p-4 sm:p-5" aria-label="Drive sharing"><div className="space-y-3">
    <div className="flex items-start gap-3">
      <ConnectorBrandMark brand="drive" />
      <div className="min-w-0 flex-1 space-y-1 pt-0.5">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p ref={target} role="status" tabIndex={-1} className="text-sm leading-5 text-foreground/70">{summary}</p>
      </div>
      {onDismiss ? <DriveSharingClose onClick={onDismiss} /> : null}
    </div>
    {view.status === "review_ready" ? <>
      <HelperText>Viewer access to these files. New matches are not included.</HelperText>
      <div aria-label="Files in this share" aria-busy={previewLoading} className="space-y-1">
        {page?.files.length ? <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">{page.files.map(file =>
          <li key={file.position} className="min-w-0 break-words">{file.name}</li>)}</ul> : null}
        {previewError ? <HelperText>Couldn’t load the file preview.</HelperText> : null}
        {previous.length || page?.nextCursor ? <div className="flex gap-2">
          <Button type="button" variant="muted" size="compact" disabled={previewLoading || !previous.length}
            onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious(items => items.slice(0, -1)); }}>Previous</Button>
          <Button type="button" variant="muted" size="compact" disabled={previewLoading || !page?.nextCursor}
            onClick={() => { setPrevious(items => [...items, cursor]); setCursor(page?.nextCursor ?? null); }}>Next 25</Button>
        </div> : null}
      </div>
      <div><HelperText>People who will receive access</HelperText>
        <ul className="text-sm">{view.recipients.map((person, index) =>
          <li key={`${person.email}:${index}`} className="break-words">{person.name ?? "A connection"} · {person.email}</li>)}</ul>
      </div>
      {view.excluded.length ? <div><HelperText>Not included</HelperText><ul className="text-sm">{view.excluded.map((person, index) =>
        <li key={index} className="break-words">{person.name ?? "A connection"} · {BULK_EXCLUSION_COPY[person.reason] ?? "unavailable"}</li>)}</ul></div> : null}
      <Button type="button" size="prominent" disabled={!!action || !view.canApprove || !page || previewError || previewLoading}
        onClick={() => void mutate("approving")}>{action === "approving" ? "Starting share…" :
          `Share ${view.fileCount.toLocaleString()} files with ${view.recipientCount} ${view.recipientCount === 1 ? "person" : "people"}`}</Button>
    </> : <>
      {!complete ? <div role="progressbar" aria-label="Drive sharing progress" aria-valuemin={0} aria-valuemax={counts.total || 1}
        aria-valuenow={counts.processed} className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${counts.total ? counts.processed / counts.total * 100 : 0}%` }} />
      </div> : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground/70">
        {counts.shared > 0 ? <span>{counts.shared.toLocaleString()} newly shared</span> : null}
        {counts.alreadyShared > 0 ? <span>{counts.alreadyShared.toLocaleString()} already had access</span> : null}
        {counts.pending > 0 ? <span>{counts.pending.toLocaleString()} remaining</span> : null}
      </div>
      {attention > 0 ? <details className="group" open={view.status === "stopped" || !!view.canRetry}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium text-foreground">
          <span className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--app-warning)]" aria-hidden="true" />
          {attention.toLocaleString()} {view.recipientCount === 1 ? (attention === 1 ? "file needs" : "files need") : (attention === 1 ? "share needs" : "shares need")} attention
          <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="space-y-2 pb-2 text-sm leading-5 text-foreground/70">
          {!view.issues?.length && counts.skipped > 0 ? <p>{counts.skipped.toLocaleString()} not shared</p> : null}
          {!view.issues?.length && counts.failed > 0 ? <p>{counts.failed.toLocaleString()} failed</p> : null}
          {counts.needsReview > 0 ? <p>{counts.needsReview.toLocaleString()} need a new review before sharing</p> : null}
          {counts.unknown > 0 ? <p>{counts.unknown.toLocaleString()} outcomes are still being checked. Check access in Drive before retrying.</p> : null}
          {view.issues?.map(issue => <p key={issue.reasonCode}>{issue.count.toLocaleString()} · {DRIVE_SHARE_ISSUE_COPY[issue.reasonCode]}</p>)}
        </div>
      </details> : null}
      {view.canRetry && !!view.retryableCount && ["partial", "failed"].includes(view.status) ?
        <Button type="button" variant="muted" size="compact"
          className="bg-[color:var(--app-accent-tint)] text-[color:var(--brand-700)] hover:bg-[color:var(--app-accent-surface)] dark:text-[color:var(--app-accent-bright)]"
          disabled={!!action} onClick={() => void mutate("retrying")}>
          {action === "retrying" ? "Retrying…" : `Retry ${view.retryableCount.toLocaleString()} unshared ${view.retryableCount === 1 ? "file" : "files"}`}
        </Button> : null}
      {!complete ? <div className="flex flex-wrap items-center justify-between gap-3">
        <HelperText className="min-w-0 flex-1">You can close this card. Sharing continues.</HelperText>
        {view.canStop ? <Button type="button" variant="muted" size="compact"
          className="text-[color:var(--app-destructive-deep)] hover:text-[color:var(--app-destructive-deep)] dark:text-[color:var(--app-destructive-bright)] dark:hover:text-[color:var(--app-destructive-bright)]" disabled={!!action} onClick={() => void mutate("stopping")}
          title="Stop remaining files. Files already shared stay available.">{action === "stopping" ? "Stopping…" : "Stop remaining"}</Button> : null}
      </div> : view.status === "stopped" ? <HelperText>Files already shared stay available.</HelperText> : null}
    </>}
  </div></Card>;
}

const DRIVE_SHARE_ISSUE_COPY: Record<import("@/lib/services/drive-sharing-service").DriveBulkReasonCode, string> = {
  source_changed: "The file changed. Review it again before sharing.",
  source_not_shareable: "Your Google account cannot share this file. Check its permissions in Drive.",
  recipient_changed: "The recipient’s Google account changed. Verify their account before a new request.",
  connection_changed: "Your Drive connection changed. Reconnect before a new request.",
  stopped: "Stopped before sharing.",
  sharing_unavailable: "Drive sharing is disabled.",
  date_range_required: "This request needs exact start and end dates. Make a new request before sharing.",
  retry_limit: "Google Drive could not finish after several attempts. Make a new request to try again.",
  provider_unavailable: "Google Drive was unavailable. Retry the unshared files.",
  permission_rejected: "Google Drive denied sharing. Check the file’s permissions in Drive.",
  permission_outcome_unknown: "Access has not been confirmed. Check it in Drive before retrying.",
  permission_catalog_incomplete: "Google Drive could not confirm existing access. Check it before retrying.",
  unavailable: "Sharing could not finish. Check the file in Drive.",
};
