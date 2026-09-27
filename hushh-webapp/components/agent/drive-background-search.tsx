"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useCoarseClock, usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText } from "@/components/app-ui/typography";
import { DriveSearchError, DriveSearchService, type DriveSearchResults, type DriveSearchSelection, type DriveSearchStatus } from "@/lib/services/drive-search-service";

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
  return <RecentSearches key={`${user.uid}:${snapshotVaultSessionEpoch()}`} getToken={getVaultOwnerToken} onUseInChat={onUseInChat} />;
}
function RecentSearches({ getToken, onUseInChat }: OwnerProps & SearchSelectionProps) {
  const owner = useOwnerGuard(getToken);
  const serial = useRef(0);
  const [jobs, setJobs] = useState<DriveSearchStatus[]>([]);
  const [error, setError] = useState(false);
  const seen = useRef(false);
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
  const invalidate = useCallback(() => { ++serial.current; }, []);
  useEffect(() => {
    void load();
    const changed = () => { seen.current = true; void load(); };
    window.addEventListener(CHANGED, changed);
    return () => { invalidate(); window.removeEventListener(CHANGED, changed); };
  }, [load, invalidate]);
  if (!jobs.length && !error) return null;
  return <details open className="mx-auto w-full max-w-4xl rounded-2xl bg-foreground/[0.035] px-4 py-2 text-sm" aria-label="Drive searches">
    <summary className="min-h-11 cursor-pointer content-center font-medium">Recent Drive searches{jobs.length ? ` · ${jobs.length}` : ""}</summary>
    {error ? <div className="space-y-2 py-2"><HelperText role="status">Couldn’t load your searches.</HelperText>
      <Button variant="muted" size="compact" onClick={() => void load()}>Try again</Button></div> : null}
    <div className="max-h-96 space-y-4 overflow-y-auto py-2">
      {jobs.map(job => <DriveBackgroundSearchCard key={job.jobId} initial={job} getToken={getToken} onUseInChat={onUseInChat} />)}
    </div>
  </details>;
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
