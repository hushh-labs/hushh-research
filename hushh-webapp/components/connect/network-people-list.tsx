"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Input } from "@/components/ui/input";
import { NetworkPersonRow } from "@/components/connect/network-person-row";
import { PersonProfileService } from "@/lib/services/person-profile-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { ConnectionsService, ConnectionsServiceRequestError, type NetworkDegree, type NetworkPage } from "@/lib/services/connections-service";
import { openPersonProfilePreview } from "@/lib/connections/person-profile-preview";
import { connectPersonName } from "@/lib/connections/person-label";
import { subscribeToConnectionGraphChanges } from "@/lib/connections/connection-graph-events";
import { getAuthSessionGeneration, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { readConnectListMemory, saveConnectListMemory, connectListScrollTop, restoreConnectListScroll } from "@/lib/connect/connect-list-memory";

type Mode = "mutuals" | "connections" | "discovery";
type Snapshot = { query: string; degree?: NetworkDegree; page: number; scrollTop: number; focusRef?: string; focusControl?: "profile" | "mutual" | "request" | "connect" };
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
  const root = useRef<HTMLElement>(null);
  const restore = useRef(Boolean(saved));
  const restoreSnapshot = useRef(saved);
  const requestRef = useRef(0);
  const previousRead = useRef<{ scope: string; page: number } | null>(null);
  const scope = JSON.stringify([owner, generation, mode, personRef, degree, query, revision]);
  const snapshot = useRef<Snapshot>({ query, degree, page, scrollTop: 0, focusRef: saved?.focusRef, focusControl: saved?.focusControl });
  snapshot.current = { ...snapshot.current, query, degree, page: result?.page ?? page };
  useLayoutEffect(() => {
    const scroll = root.current?.closest<HTMLElement>("[data-network-scroll-owner]");
    return () => {
      if (generation !== getAuthSessionGeneration()) return;
      saveConnectListMemory(owner, memoryKey, { ...snapshot.current, scrollTop: scroll?.scrollTop ?? connectListScrollTop() });
    };
  }, [generation, owner, memoryKey]);

  const refresh = useCallback(() => {
    const opener = root.current?.contains(document.activeElement) ? document.activeElement?.closest<HTMLElement>("[data-network-person]") : null;
    restoreSnapshot.current = { ...snapshot.current,
      scrollTop: root.current?.closest<HTMLElement>("[data-network-scroll-owner]")?.scrollTop ?? connectListScrollTop(),
      focusRef: opener?.dataset.networkPerson,
      focusControl: opener?.dataset.networkFocus === "mutual" ? "mutual" : opener?.dataset.networkFocus === "request" ? "request" : opener?.dataset.networkFocus === "connect" ? "connect" : "profile",
    };
    restore.current = true;
    setResult(null); setRevision(value => value + 1);
  }, []);
  useEffect(() => subscribeToConnectionGraphChanges(event => {
    if (event.userId === owner) refresh();
  }), [owner, refresh]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    const request = ++requestRef.current;
    const append = previousRead.current?.scope === scope && page > previousRead.current.page;
    previousRead.current = { scope, page };
    setBusy(true); setError(null);
    if (!append) setResult(null);
    if (!user) { setBusy(false); return () => controller.abort(); }
    const timer = setTimeout(() => void (async () => {
      try {
        const idToken = await user.getIdToken();
        if (controller.signal.aborted || generation !== getAuthSessionGeneration()) return;
        const pages: NetworkPage[] = [];
        for (let next = 1; next <= page; next++) {
          const value = mode === "mutuals" && personRef
            ? await ConnectionsService.listMutualConnections({ idToken, personRef, page: next, signal: controller.signal })
            : await ConnectionsService.listNetwork({ idToken, personRef: mode === "connections" ? personRef : undefined, degree, query, page: next, signal: controller.signal });
          pages.push(value);
          if (!value.hasMore) break;
        }
        if (controller.signal.aborted || request !== requestRef.current || generation !== getAuthSessionGeneration()) return;
        const last = pages[pages.length - 1];
        if (last) setResult({ ...last, items: [...new Map(pages.flatMap(value => value.items).map(person => [person.publicPersonRef, person])).values()] });
      } catch (failure) {
        if (controller.signal.aborted || request !== requestRef.current || generation !== getAuthSessionGeneration()) return;
        setResult(null);
        const unavailable = failure instanceof ConnectionsServiceRequestError && [401, 403, 404].includes(failure.status);
        if (unavailable) saveConnectListMemory(owner, memoryKey, null);
        setError(unavailable ? "This connection list is unavailable." : "Could not load connections. Please try again.");
      } finally {
        if (!controller.signal.aborted && request === requestRef.current && generation === getAuthSessionGeneration()) setBusy(false);
      }
    })(), query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [user, owner, generation, mode, personRef, degree, query, page, revision, memoryKey, scope]);

  useEffect(() => { if (result && !busy) onReady?.(); }, [result, busy, onReady]);

  useEffect(() => {
    const retained = restoreSnapshot.current;
    if (!result || !restore.current || !retained) return;
    restore.current = false;
    const scroll = root.current?.closest<HTMLElement>("[data-network-scroll-owner]");
    const frame = requestAnimationFrame(() => {
      if (scroll) scroll.scrollTop = retained.scrollTop;
      const controls = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-network-person]") ?? []).filter(element => element.dataset.networkPerson === retained.focusRef);
      const target = controls.find(element => (element.dataset.networkFocus ?? "profile") === (retained.focusControl ?? "profile"))
        ?? controls.find(element => !element.dataset.networkFocus);
      target?.focus({ preventScroll: true });
    });
    const cancel = !scroll ? restoreConnectListScroll(retained.scrollTop) : undefined;
    return () => { cancelAnimationFrame(frame); cancel?.(); };
  }, [result]);

  const title = mode === "discovery" ? "Explore your network" : mode === "mutuals" ? `${result?.totalCount ?? ""} mutual ${result?.totalCount === 1 ? "connection" : "connections"}`.trim() : result?.person ? `${connectPersonName(result.person)}’s connections` : "Connections";
  const remember = (personRef: string, focusControl: "profile" | "mutual" | "request" | "connect" = "profile") => {
    const scrollTop = root.current?.closest<HTMLElement>("[data-network-scroll-owner]")?.scrollTop ?? connectListScrollTop();
    snapshot.current = { query, degree, page: result?.page ?? page, scrollTop, focusRef: personRef, focusControl };
    saveConnectListMemory(owner, memoryKey, snapshot.current);
  };
  // A refresh can replace rows while their explicit Connect actions are pending.
  // Keep intent/duplicate guards with the list owner, not a transient row.
  const connect = async (personRef: string) => {
    if (!user || !owner || connectionIntents.current.has(personRef)) return;
    connectionIntents.current.add(personRef);
    setConnecting(new Set(connectionIntents.current));
    setConnectionErrors(current => { const next = { ...current }; delete next[personRef]; return next; });
    remember(personRef, "connect");
    const active = () => Boolean(root.current?.isConnected) && generation === getAuthSessionGeneration();
    try {
      const token = await user.getIdToken();
      if (!active()) return;
      await PersonProfileService.connect(personRef, token);
      // Committed writes still wake this owner after their source list closes.
      if (generation === getAuthSessionGeneration()) CacheSyncService.onConnectionGraphMutated(owner);
    } catch {
      if (active()) setConnectionErrors(current => ({ ...current, [personRef]: "Could not send request. Please try again." }));
    } finally {
      connectionIntents.current.delete(personRef);
      if (active()) setConnecting(new Set(connectionIntents.current));
    }
  };
  return <section ref={root} className="mx-auto w-full max-w-[880px] space-y-4 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:px-6" data-testid={mode === "mutuals" ? "mutual-connections-list" : "network-people-list"}>
    <header className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
      <h1 className="break-words text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{mode === "mutuals" ? `People connected to both you${result?.person ? ` and ${connectPersonName(result.person)}` : " and this person"}.` : mode === "connections" ? "This person has allowed their direct connections to browse this list." : "Discover people through connections that allow network discovery. Degrees are relative to you."}</p>
      {mode === "mutuals" && result?.hasMore && result.totalCount !== undefined ? <p className="text-sm text-muted-foreground">Showing {result.items.length} of {result.totalCount}</p> : null}
    </header>
    {mode !== "mutuals" ? <Input aria-label="Search network by name" placeholder="Search by name" value={query} onChange={event => { restore.current = false; setQuery(event.target.value); setPage(1); }} /> : null}
    {mode === "discovery" ? <div className="space-y-2">
      <div className="flex flex-wrap gap-2" aria-label="Connection degree filters">
        {([undefined, 1, 2, 3] as const).map(value => <button key={value ?? "all"} type="button" aria-pressed={degree === value} aria-describedby="network-filter-help" className="min-h-11 rounded-full border px-4 text-sm aria-pressed:bg-primary aria-pressed:text-primary-foreground" onClick={() => { restore.current = false; setDegree(value); setPage(1); }}>{value === 1 ? "My connections" : value === 2 ? "Through connections" : value === 3 ? "Extended network" : "All"}</button>)}
      </div>
      <p id="network-filter-help" className="text-sm text-muted-foreground">{degree === 1 ? "People you’re directly connected to." : degree === 2 ? "People who share a connection with you." : degree === 3 ? "People one step beyond your connections’ connections, where sharing is enabled." : "People in your direct connections and wider shared network."}</p>
    </div> : null}
    {busy && !result ? <p role="status" className="py-6 text-muted-foreground">Loading connections…</p> : null}
    {error ? <div role="alert" className="space-y-2"><p>{error}</p><button type="button" className="min-h-11 rounded-full border px-4" onClick={() => setRevision(value => value + 1)}>Try again</button></div> : null}
    {result ? <ul className="divide-y rounded-2xl border bg-card" aria-busy={busy}>
      {result.items.map(person => <NetworkPersonRow key={person.publicPersonRef} person={person}
        connecting={connecting.has(person.publicPersonRef)} connectionError={connectionErrors[person.publicPersonRef]}
        onConnect={() => void connect(person.publicPersonRef)} onRemember={() => remember(person.publicPersonRef, "mutual")} onOpen={element => {
        remember(person.publicPersonRef, element.dataset.networkFocus === "request" ? "request" : "profile");
        openPersonProfilePreview({ personRef: person.publicPersonRef }, element);
      }} />)}
    </ul> : null}
    {result && !result.items.length ? <p role="status" className="py-4 text-muted-foreground">No profiles to show{query ? " for this name" : " right now"}.</p> : null}
    {result && !result.hasMore && result.totalCount !== undefined && result.items.length < result.totalCount ? <p className="text-sm text-muted-foreground">Some mutual connections are unavailable to view.</p> : null}
    {result?.hasMore ? <button type="button" className="min-h-11 rounded-full border px-5" disabled={busy} onClick={() => setPage(result.page + 1)}>{mode === "mutuals" ? "Load more mutual connections" : "Load more connections"}</button> : null}
  </section>;
}
