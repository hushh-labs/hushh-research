"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Input } from "@/components/ui/input";
import { Search } from "@/components/icons";
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
type ListProps = { mode: Mode; personRef?: string; visitKey: string; embedded?: boolean; onReady?: () => void; onDismiss?: () => void };
const networkFilters = [undefined, 1, 2, 3] as const;
type FirstPages = {
  pages: Map<NetworkDegree | undefined, NetworkPage>;
  read: (degree?: NetworkDegree) => Promise<NetworkPage>;
};

function markRequests(page: NetworkPage, requested: ReadonlySet<string>): NetworkPage {
  if (requested.size === 0) return page;
  const mark = (person: NetworkPage["items"][number]) =>
    requested.has(person.publicPersonRef) && (!person.relationship || person.relationship === "none")
      ? { ...person, relationship: "pending_outgoing" as const }
      : person;
  return { ...page, items: page.items.map(mark), suggestions: page.suggestions?.map(mark) };
}
export function networkDegreeLabel(degree: NetworkDegree | null | undefined): string | null {
  return degree === 1 ? "1st" : degree === 2 ? "2nd" : degree === 3 ? "3rd" : null;
}

/** Shared list owner; private rows are never retained in navigation memory. */
export function NetworkPeopleList(props: ListProps) {
  const { userId } = useAuth();
  const generation = useSyncExternalStore(subscribeAuthSessionGeneration, getAuthSessionGeneration, () => null);
  return <NetworkListSession key={`${userId ?? "signed-out"}:${generation}`} {...props} />;
}
function NetworkListSession({ mode, personRef, visitKey, embedded, onReady, onDismiss }: ListProps) {
  const { user, userId: owner } = useAuth();
  const generation = getAuthSessionGeneration();
  const memoryKey = `network:${visitKey}`;
  const [saved] = useState(() => readConnectListMemory<Snapshot>(owner, memoryKey));
  const [query, setQuery] = useState(saved?.query ?? "");
  const [degree, setDegree] = useState<NetworkDegree | undefined>(saved?.degree);
  const extended = mode === "discovery" && degree === 3;
  const [page, setPage] = useState(saved?.page ?? 1);
  const [result, setResult] = useState<NetworkPage | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const [connecting, setConnecting] = useState<Set<string>>(() => new Set());
  const connectionIntents = useRef(new Set<string>());
  const requestedPeople = useRef(new Set<string>());
  const notifyingOwnRequest = useRef(false);
  const firstPages = useRef<FirstPages | null>(null);
  const preserveOnRefresh = useRef(false);
  const lastForegroundRefresh = useRef(0);
  const [connectionErrors, setConnectionErrors] = useState<Record<string, string>>({});
  const root = useRef<HTMLElement>(null);
  const restore = useRef(Boolean(saved));
  const restoreSnapshot = useRef(saved);
  const requestRef = useRef(0);
  const lastSuccessfulRead = useRef<{ scope: string; page: number } | null>(null);
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

  const refresh = useCallback((preserveRows = false) => {
    const opener = root.current?.contains(document.activeElement) ? document.activeElement?.closest<HTMLElement>("[data-network-person]") : null;
    restoreSnapshot.current = { ...snapshot.current,
      scrollTop: root.current?.closest<HTMLElement>("[data-network-scroll-owner]")?.scrollTop ?? connectListScrollTop(),
      focusRef: opener?.dataset.networkPerson,
      focusControl: opener?.dataset.networkFocus === "mutual" ? "mutual" : opener?.dataset.networkFocus === "request" ? "request" : opener?.dataset.networkFocus === "connect" ? "connect" : "profile",
    };
    restore.current = true;
    requestedPeople.current.clear();
    firstPages.current = null;
    preserveOnRefresh.current = preserveRows;
    if (!preserveRows) setResult(null);
    setRevision(value => value + 1);
  }, []);
  useEffect(() => subscribeToConnectionGraphChanges(event => {
    if (event.userId === owner && !notifyingOwnRequest.current) refresh();
  }), [owner, refresh]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState !== "visible") {
        lastForegroundRefresh.current = 0;
        return;
      }
      if (Date.now() - lastForegroundRefresh.current < 200) return;
      lastForegroundRefresh.current = Date.now();
      refresh();
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);

  useEffect(() => {
    if (!user || mode !== "discovery") return;
    const controller = new AbortController();
    const pages = new Map<NetworkDegree | undefined, NetworkPage>();
    const requests = new Map<NetworkDegree | undefined, Promise<NetworkPage>>();
    let token: Promise<string> | undefined;
    const read = (filter?: NetworkDegree) => {
      const cached = pages.get(filter);
      if (cached) return Promise.resolve(cached);
      const pending = requests.get(filter);
      if (pending) return pending;
      token ??= user.getIdToken().catch(failure => {
        token = undefined;
        throw failure;
      });
      const request = token.then(idToken => {
        if (controller.signal.aborted || generation !== getAuthSessionGeneration()) {
          throw new DOMException("Network view closed", "AbortError");
        }
        return ConnectionsService.listNetwork({
          idToken, degree: filter, query, page: 1, includeSuggestions: filter === 3, signal: controller.signal,
        });
      }).then(value => {
        if (!controller.signal.aborted && generation === getAuthSessionGeneration()) pages.set(filter, value);
        return value;
      }).finally(() => requests.delete(filter));
      requests.set(filter, request);
      return request;
    };
    const cache = { pages, read };
    firstPages.current = cache;
    // Warm the unfiltered first pages once per open view. Typed searches use only the selected filter.
    if (!query.trim() && !saved && revision === 0) {
      for (const filter of networkFilters) void read(filter).catch(() => {});
    }
    return () => {
      controller.abort();
      if (firstPages.current === cache) firstPages.current = null;
    };
  }, [user, generation, mode, query, revision, saved]);

  useEffect(() => {
    const controller = new AbortController();
    const request = ++requestRef.current;
    const previous = lastSuccessfulRead.current;
    const append = previous?.scope === scope && page === previous.page + 1;
    const cache = mode === "discovery" ? firstPages.current : null;
    const cached = page === 1 ? cache?.pages.get(degree) : undefined;
    const keepRows = preserveOnRefresh.current;
    preserveOnRefresh.current = false;
    if (cached) {
      lastSuccessfulRead.current = { scope, page: cached.page };
      setResult(markRequests(cached, requestedPeople.current));
      setBusy(false);
      setError(null);
      return () => controller.abort();
    }
    setBusy(true); setError(null);
    if (!append) {
      lastSuccessfulRead.current = null;
      if (!keepRows) setResult(null);
    }
    if (!user) { setBusy(false); return () => controller.abort(); }
    const timer = setTimeout(() => void (async () => {
      try {
        const pages: NetworkPage[] = [];
        let idToken: string | undefined;
        for (let next = append ? page : 1; next <= page; next++) {
          if (controller.signal.aborted || generation !== getAuthSessionGeneration()) return;
          if (next === 1 && cache) {
            const first = await cache.read(degree);
            pages.push(first);
            if (!first.hasMore) break;
            continue;
          }
          idToken ??= await user.getIdToken();
          if (controller.signal.aborted || generation !== getAuthSessionGeneration()) return;
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
            return markRequests({
              ...last,
              items: [...new Map(merged.map(person => [person.publicPersonRef, person])).values()],
              suggestions: append ? current?.suggestions : pages[0]?.suggestions,
            }, requestedPeople.current);
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
    const retained = restoreSnapshot.current;
    if (!result || !restore.current || !retained) return;
    restore.current = false;
    const scroll = root.current?.closest<HTMLElement>("[data-network-scroll-owner]");
    const frame = requestAnimationFrame(() => {
      if (scroll) scroll.scrollTop = retained.scrollTop;
      const controls = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("button[data-network-person]") ?? []).filter(element => element.dataset.networkPerson === retained.focusRef);
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
      const relationship = await PersonProfileService.connect(personRef, token);
      // Committed writes still wake this owner after their source list closes.
      if (generation !== getAuthSessionGeneration()) return;
      const pending = active() && relationship?.status === "pending_outgoing";
      const connected = active() && relationship?.status === "connected";
      if (pending) {
        if (document.activeElement instanceof HTMLElement
          && document.activeElement.dataset.networkPerson === personRef
          && document.activeElement.dataset.networkFocus === "connect") {
          remember(personRef, "connect");
          restoreSnapshot.current = snapshot.current;
          restore.current = true;
        }
        requestedPeople.current.add(personRef);
        setResult(current => current ? markRequests(current, requestedPeople.current) : current);
      } else if (connected) refresh(true);
      notifyingOwnRequest.current = pending || connected;
      try { CacheSyncService.onConnectionGraphMutated(owner); }
      finally { notifyingOwnRequest.current = false; }
    } catch {
      if (active()) setConnectionErrors(current => ({ ...current, [personRef]: "Could not send request. Please try again." }));
    } finally {
      connectionIntents.current.delete(personRef);
      if (active()) setConnecting(new Set(connectionIntents.current));
    }
  };
  const networkPeople = result?.items ?? [];
  const networkRefs = new Set(networkPeople.map(person => person.publicPersonRef));
  const people = extended
    ? [...networkPeople, ...(result?.suggestions ?? []).filter(person => !networkRefs.has(person.publicPersonRef))]
    : networkPeople;
  const Heading = embedded ? "h3" : "h1";
  return <section ref={root} className="mx-auto w-full max-w-[880px] space-y-3 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:space-y-4 sm:px-5" data-testid={mode === "mutuals" ? "mutual-connections-list" : "network-people-list"}>
    <header className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
      {!embedded || mode !== "discovery" ? <Heading>{title}</Heading> : null}
      <p className="max-w-prose text-sm leading-snug text-muted-foreground">{mode === "mutuals" ? `People connected to both you${result?.person ? ` and ${connectPersonName(result.person)}` : " and this person"}.` : mode === "connections" ? "This person has allowed their direct connections to browse this list." : extended ? "Third-degree connections and suggested people." : "Find people through connections that allow discovery."}</p>
      {mode === "mutuals" && result?.hasMore && result.totalCount !== undefined ? <p className="text-sm text-muted-foreground">Showing {result.items.length} of {result.totalCount}</p> : null}
    </header>
    {mode !== "mutuals" ? (
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label={extended ? "Search people by name" : "Search network by name"} placeholder="Search by name" value={query} className="ps-9" maxLength={160}
          onChange={event => {
            if (event.target.value === query) return;
            restore.current = false;
            firstPages.current = null;
            setResult(null);
            setBusy(true);
            setError(null);
            setQuery(event.target.value);
            setPage(1);
          }} />
      </div>
    ) : null}
    {mode === "discovery" ? (
      <div className="grid grid-cols-2 gap-1.5 min-[480px]:flex min-[480px]:flex-wrap" role="group" aria-label="Connection degree filters">
        {networkFilters.map(value => (
          <button
            key={value ?? "all"}
            type="button"
            aria-pressed={degree === value}
            className="min-h-11 min-w-0 rounded-full border px-2 py-1.5 text-xs leading-tight [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground min-[360px]:text-sm sm:px-3"
            onClick={() => {
              if (value === degree) return;
              restore.current = false;
              const cached = firstPages.current?.pages.get(value);
              setResult(cached ? markRequests(cached, requestedPeople.current) : null);
              setBusy(!cached);
              setError(null);
              setDegree(value);
              setPage(1);
            }}
          >
            {value === 1 ? "My connections" : value === 2 ? "Through connections" : value === 3 ? "Extended network" : "All"}
          </button>
        ))}
      </div>
    ) : null}
    {busy && !result ? <p role="status" className="py-3 text-sm text-muted-foreground">Loading connections…</p> : null}
    {error ? <div role="alert" className="space-y-2"><p>{error}</p><button type="button" className="min-h-11 rounded-full border px-4" onClick={() => setRetry(value => value + 1)}>Try again</button></div> : null}
    {people.length ? <ul className="divide-y rounded-xl border bg-card" aria-busy={busy} aria-label={extended ? "Extended network people" : undefined}>
      {people.map(person => <NetworkPersonRow key={person.publicPersonRef} person={person}
        connecting={connecting.has(person.publicPersonRef)} connectionError={connectionErrors[person.publicPersonRef]}
        onConnect={() => void connect(person.publicPersonRef)} onRemember={() => remember(person.publicPersonRef, "mutual")} onOpen={element => {
        remember(person.publicPersonRef, element.dataset.networkFocus === "request" ? "request" : "profile");
        openPersonProfilePreview({ personRef: person.publicPersonRef }, element);
      }} />)}
    </ul> : null}
    {result && !people.length ? <div className="py-3 text-sm text-muted-foreground">
      <p role="status">{extended && !query.trim()
        ? "No people to show yet. Search by name to get started."
        : `No profiles to show${query.trim() ? " for this name" : " right now"}.`}</p>
      {extended && !query.trim() && onDismiss ? <button type="button"
        data-voice-control-id="network-find-people"
        className="min-h-11 rounded-md text-primary hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onDismiss}>Back to Find people</button> : null}
    </div> : null}
    {result && !result.hasMore && result.totalCount !== undefined && result.items.length < result.totalCount ? <p className="text-sm text-muted-foreground">Some mutual connections are unavailable to view.</p> : null}
    {result?.hasMore && !error ? <button type="button" className="min-h-11 rounded-full border px-5" disabled={busy} onClick={() => setPage(result.page + 1)}>{mode === "mutuals" ? "Load more mutual connections" : "Load more connections"}</button> : null}
  </section>;
}
