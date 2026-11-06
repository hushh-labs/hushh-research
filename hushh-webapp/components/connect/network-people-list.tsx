"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Input } from "@/components/ui/input";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { ConnectionsService, ConnectionsServiceRequestError, type NetworkDegree, type NetworkPage } from "@/lib/services/connections-service";
import { openPersonProfilePreview } from "@/lib/connections/person-profile-preview";
import { connectPersonName } from "@/lib/connections/person-label";
import { subscribeToConnectionGraphChanges } from "@/lib/connections/connection-graph-events";
import { getAuthSessionGeneration, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { readConnectListMemory, saveConnectListMemory, connectListScrollTop, restoreConnectListScroll } from "@/lib/connect/connect-list-memory";

type Mode = "mutuals" | "connections" | "discovery";
type Snapshot = { query: string; degree?: NetworkDegree; page: number; scrollTop: number; focusRef?: string };
type ListProps = { mode: Mode; personRef?: string; visitKey: string; onReady?: () => void };
export function networkDegreeLabel(degree: NetworkDegree | null | undefined): string | null {
  return degree === 1 ? "1st" : degree === 2 ? "2nd" : degree === 3 ? "3rd" : null;
}

/** Shared list owner; private rows are never retained in navigation memory. */
export function NetworkPeopleList(props: ListProps) {
  const { userId } = useAuth();
  const generation = useSyncExternalStore(subscribeAuthSessionGeneration, getAuthSessionGeneration, () => null);
  return <NetworkListSession key={`${userId ?? "signed-out"}:${generation}`} {...props} />;
}
function NetworkListSession({ mode, personRef, visitKey, onReady }: ListProps) {
  const { user, userId: owner } = useAuth();
  const generation = getAuthSessionGeneration();
  const memoryKey = `network:${visitKey}`;
  const [saved] = useState(() => readConnectListMemory<Snapshot>(owner, memoryKey));
  const [query, setQuery] = useState(saved?.query ?? "");
  const [degree, setDegree] = useState<NetworkDegree | undefined>(saved?.degree);
  const [page, setPage] = useState(saved?.page ?? 1);
  const [result, setResult] = useState<NetworkPage | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const root = useRef<HTMLElement>(null);
  const restore = useRef(Boolean(saved));
  const requestRef = useRef(0);
  const lastSuccessfulRead = useRef<{ scope: string; page: number } | null>(null);
  const scope = JSON.stringify([owner, generation, mode, personRef, degree, query, revision]);
  const snapshot = useRef<Snapshot>({ query, degree, page, scrollTop: 0, focusRef: saved?.focusRef });
  snapshot.current = { ...snapshot.current, query, degree, page: result?.page ?? page };
  useLayoutEffect(() => {
    const scroll = root.current?.closest<HTMLElement>("[data-network-scroll-owner]");
    return () => {
      if (generation !== getAuthSessionGeneration()) return;
      saveConnectListMemory(owner, memoryKey, { ...snapshot.current, scrollTop: scroll?.scrollTop ?? connectListScrollTop() });
    };
  }, [generation, owner, memoryKey]);

  useEffect(() => subscribeToConnectionGraphChanges(event => {
    if (event.userId === owner) { setResult(null); setRevision(value => value + 1); }
  }), [owner]);
  useEffect(() => {
    const refresh = () => { setResult(null); setRevision(value => value + 1); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const request = ++requestRef.current;
    const previous = lastSuccessfulRead.current;
    const append = previous?.scope === scope && page === previous.page + 1;
    setBusy(true); setError(null);
    if (!append) {
      lastSuccessfulRead.current = null;
      setResult(null);
    }
    if (!user) { setBusy(false); return () => controller.abort(); }
    const timer = setTimeout(() => void (async () => {
      try {
        const idToken = await user.getIdToken();
        if (controller.signal.aborted || generation !== getAuthSessionGeneration()) return;
        const pages: NetworkPage[] = [];
        for (let next = append ? page : 1; next <= page; next++) {
          const value = mode === "mutuals" && personRef
            ? await ConnectionsService.listMutualConnections({ idToken, personRef, page: next, signal: controller.signal })
            : await ConnectionsService.listNetwork({ idToken, personRef: mode === "connections" ? personRef : undefined, degree, query, page: next, signal: controller.signal });
          pages.push(value);
          if (!value.hasMore) break;
        }
        if (controller.signal.aborted || request !== requestRef.current || generation !== getAuthSessionGeneration()) return;
        const last = pages[pages.length - 1];
        if (last) {
          lastSuccessfulRead.current = { scope, page: last.page };
          const items = pages.flatMap(value => value.items);
          setResult(current => {
            const merged = append && current ? [...current.items, ...items] : items;
            return { ...last, items: [...new Map(merged.map(person => [person.publicPersonRef, person])).values()] };
          });
        }
      } catch (failure) {
        if (controller.signal.aborted || request !== requestRef.current || generation !== getAuthSessionGeneration()) return;
        const status = failure instanceof ConnectionsServiceRequestError ? failure.status : null;
        const unavailable = status !== null && [401, 403, 404].includes(status);
        // Requalification failures can invalidate previously visible rows. Only a rate limit permits retaining them.
        if (!append || status !== 429) {
          lastSuccessfulRead.current = null;
          setResult(null);
        }
        if (unavailable) saveConnectListMemory(owner, memoryKey, null);
        setError(unavailable ? "This connection list is unavailable." : "Could not load connections. Please try again.");
      } finally {
        if (!controller.signal.aborted && request === requestRef.current && generation === getAuthSessionGeneration()) setBusy(false);
      }
    })(), query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [user, owner, generation, mode, personRef, degree, query, page, revision, retry, memoryKey, scope]);

  useEffect(() => { if (result && !busy && !error) onReady?.(); }, [result, busy, error, onReady]);

  useEffect(() => {
    if (!result || !restore.current || !saved) return;
    restore.current = false;
    const scroll = root.current?.closest<HTMLElement>("[data-network-scroll-owner]");
    const frame = requestAnimationFrame(() => {
      if (scroll) scroll.scrollTop = saved.scrollTop;
      Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-network-person]") ?? []).find(element => element.dataset.networkPerson === saved.focusRef)?.focus({ preventScroll: true });
    });
    const cancel = !scroll ? restoreConnectListScroll(saved.scrollTop) : undefined;
    return () => { cancelAnimationFrame(frame); cancel?.(); };
  }, [result, saved]);

  const title = mode === "discovery" ? "Explore your network" : mode === "mutuals" ? `${result?.totalCount ?? ""} mutual ${result?.totalCount === 1 ? "connection" : "connections"}`.trim() : result?.person ? `${connectPersonName(result.person)}’s connections` : "Connections";
  return <section ref={root} className="mx-auto w-full max-w-[880px] space-y-4 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:px-6" data-testid={mode === "mutuals" ? "mutual-connections-list" : "network-people-list"}>
    <header className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
      <h1 className="break-words text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{mode === "mutuals" ? `People connected to both you${result?.person ? ` and ${connectPersonName(result.person)}` : " and this person"}.` : mode === "connections" ? "This person has allowed their direct connections to browse this list." : "Discover people through connections that allow network discovery. Degrees are relative to you."}</p>
      {mode === "mutuals" && result?.hasMore && result.totalCount !== undefined ? <p className="text-sm text-muted-foreground">Showing {result.items.length} of {result.totalCount}</p> : null}
    </header>
    {mode !== "mutuals" ? <Input aria-label="Search network by name" placeholder="Search by name" value={query} onChange={event => { restore.current = false; setQuery(event.target.value); setPage(1); }} /> : null}
    {mode === "discovery" ? <div className="flex flex-wrap gap-2" aria-label="Connection degree filters">
      {([undefined, 1, 2, 3] as const).map(value => <button key={value ?? "all"} type="button" aria-pressed={degree === value} className="min-h-11 min-w-14 rounded-full border px-4 text-sm aria-pressed:bg-primary aria-pressed:text-primary-foreground" onClick={() => { restore.current = false; setDegree(value); setPage(1); }}>{value ? networkDegreeLabel(value) : "All"}</button>)}
    </div> : null}
    {busy && !result ? <p role="status" className="py-6 text-muted-foreground">Loading connections…</p> : null}
    {error ? <div role="alert" className="space-y-2"><p>{error}</p><button type="button" className="min-h-11 rounded-full border px-4" onClick={() => setRetry(value => value + 1)}>Try again</button></div> : null}
    {result ? <ul className="divide-y rounded-2xl border bg-card" aria-busy={busy}>
      {result.items.map(person => <li key={person.publicPersonRef}><button type="button" data-network-person={person.publicPersonRef} aria-label={`Open ${connectPersonName(person)}'s profile`} className="flex min-h-[76px] w-full items-center gap-3 rounded-xl px-4 py-3 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring" onClick={event => {
        const scrollTop = root.current?.closest<HTMLElement>("[data-network-scroll-owner]")?.scrollTop ?? connectListScrollTop();
        snapshot.current = { query, degree, page: result.page, scrollTop, focusRef: person.publicPersonRef };
        saveConnectListMemory(owner, memoryKey, snapshot.current);
        openPersonProfilePreview({ personRef: person.publicPersonRef }, event.currentTarget);
      }}>
        <ConnectionPersonAvatar label={connectPersonName(person)} photoUrl={person.photoUrl} size="list" />
        <span className="min-w-0 flex-1 break-words font-medium">{connectPersonName(person)}</span>
        {networkDegreeLabel(person.networkDegree) ? <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs">{networkDegreeLabel(person.networkDegree)}</span> : null}
        <span className="hidden shrink-0 text-sm text-muted-foreground sm:inline" aria-hidden="true">View profile</span>
      </button></li>)}
    </ul> : null}
    {result && !result.items.length ? <p role="status" className="py-4 text-muted-foreground">No profiles to show{query ? " for this name" : " right now"}.</p> : null}
    {result && !result.hasMore && result.totalCount !== undefined && result.items.length < result.totalCount ? <p className="text-sm text-muted-foreground">Some mutual connections are unavailable to view.</p> : null}
    {result?.hasMore && !error ? <button type="button" className="min-h-11 rounded-full border px-5" disabled={busy} onClick={() => setPage(result.page + 1)}>{mode === "mutuals" ? "Load more mutual connections" : "Load more connections"}</button> : null}
  </section>;
}
