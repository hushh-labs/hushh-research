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
import { DIRECTORY_PASSIVE_REFRESH_AFTER_MS } from "@/lib/connect/directory-first-page-cache";
import { usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { cn } from "@/lib/utils";

type Mode = "mutuals" | "connections" | "discovery";
type Snapshot = { query: string; degree?: NetworkDegree; page: number; scrollTop: number; focusRef?: string; focusControl?: "profile" | "mutual" | "request" | "connect" };
type ListProps = { mode: Mode; personRef?: string; visitKey: string; embedded?: boolean; onReady?: () => void; onDismiss?: () => void };
const networkFilters = [undefined, 1, 2, 3] as const;
type FirstPages = {
  pages: Map<NetworkDegree | undefined, NetworkPage>;
  read: (degree?: NetworkDegree) => Promise<NetworkPage>;
};

function markRequests(page: NetworkPage, requested: ReadonlySet<string>): NetworkPage {
  const mark = (person: NetworkPage["items"][number]) =>
    requested.has(person.publicPersonRef) && (!person.relationship || person.relationship === "none")
      ? { ...person, relationship: "pending_outgoing" as const }
      : person;
  const items = new Map<string, NetworkPage["items"][number]>();
  for (const person of page.items) {
    const previous = items.get(person.publicPersonRef);
    // A later public recommendation must not demote a qualified graph row.
    if (!previous?.networkDegree || person.networkDegree) items.set(person.publicPersonRef, mark(person));
  }
  return { ...page, items: [...items.values()], suggestions: page.suggestions?.map(mark) };
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
  const [draftQuery, setDraftQuery] = useState(saved?.query ?? "");
  const query = useDebouncedValue(draftQuery.trim(), 250);
  const searchPending = draftQuery.trim() !== query;
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
  const lastReadAt = useRef(0);
  const lastForegroundRefresh = useRef(0);
  const [connectionErrors, setConnectionErrors] = useState<Record<string, string>>({});
  const root = useRef<HTMLElement>(null);
  const restore = useRef(Boolean(saved));
  const restoreSnapshot = useRef(saved);
  const requestRef = useRef(0);
  const lastSuccessfulRead = useRef<{ scope: string; page: number } | null>(null);
  const scope = JSON.stringify([owner, generation, mode, personRef, degree, query, revision]);
  const snapshot = useRef<Snapshot>({ query, degree, page, scrollTop: 0, focusRef: saved?.focusRef, focusControl: saved?.focusControl });
  snapshot.current = { ...snapshot.current, query: draftQuery, degree, page: restore.current && busy ? page : result?.page ?? page };
  useLayoutEffect(() => {
    const scroll = root.current?.closest<HTMLElement>("[data-network-scroll-owner]");
    return () => {
      if (generation !== getAuthSessionGeneration()) return;
      saveConnectListMemory(owner, memoryKey, { ...snapshot.current, scrollTop: scroll?.scrollTop ?? connectListScrollTop() });
    };
  }, [generation, owner, memoryKey]);

  const refresh = useCallback((preserveRows = false) => {
    ++requestRef.current;
    lastReadAt.current = Date.now();
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
  usePeriodicTask(`network-people-availability:${owner}:${visitKey}`, DIRECTORY_PASSIVE_REFRESH_AFTER_MS, () => {
    if (!busy && navigator.onLine !== false) refresh(true);
  }, { enabled: Boolean(user && owner) });
  useEffect(() => subscribeToConnectionGraphChanges(event => {
    if (event.userId === owner && !notifyingOwnRequest.current) refresh();
  }), [owner, refresh]);
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastForegroundRefresh.current < 200) return;
      if (mode === "discovery" && now - lastReadAt.current < DIRECTORY_PASSIVE_REFRESH_AFTER_MS) return;
      lastForegroundRefresh.current = now;
      refresh(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        lastForegroundRefresh.current = Date.now();
        refresh();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisibility); };
  }, [mode, refresh]);

  useEffect(() => {
    if (!user || mode !== "discovery" || searchPending) return;
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
    return () => {
      controller.abort();
      if (firstPages.current === cache) firstPages.current = null;
    };
  }, [user, generation, mode, query, revision, searchPending]);

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
      lastReadAt.current = Date.now();
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
    if (!user || searchPending) {
      if (!user) setBusy(false);
      return () => controller.abort();
    }
    void (async () => {
      try {
        const pages: NetworkPage[] = [];
        let idToken: string | undefined;
        for (let next = append ? page : 1; next <= page; next++) {
          if (controller.signal.aborted || generation !== getAuthSessionGeneration()) return;
          let value: NetworkPage;
          if (next === 1 && cache) {
            value = await cache.read(degree);
            // Give the requested tab priority, including the pages that must
            // be requalified to restore its scroll position on Back.
            if (page === 1 && !query && revision === 0 && !controller.signal.aborted && request === requestRef.current) {
              for (const filter of networkFilters) if (filter !== degree) void cache.read(filter).catch(() => {});
            }
          } else {
            idToken ??= await user.getIdToken();
            if (controller.signal.aborted || generation !== getAuthSessionGeneration()) return;
            value = mode === "mutuals" && personRef
              ? await ConnectionsService.listMutualConnections({ idToken, personRef, page: next, signal: controller.signal })
              : await ConnectionsService.listNetwork({ idToken, personRef: mode === "connections" ? personRef : undefined, degree, query, page: next, includeSuggestions: mode === "discovery" && degree === 3, signal: controller.signal });
          }
          if (controller.signal.aborted || request !== requestRef.current || generation !== getAuthSessionGeneration()) return;
          pages.push(value);
          if (!keepRows && next === 1 && page > 1 && value.hasMore) {
            setResult(markRequests(value, requestedPeople.current));
          }
          if (!value.hasMore) break;
        }
        if (controller.signal.aborted || request !== requestRef.current || generation !== getAuthSessionGeneration()) return;
        const last = pages[pages.length - 1];
        if (last) {
          lastReadAt.current = Date.now();
          lastSuccessfulRead.current = { scope, page: last.page };
          const items = pages.flatMap(value => value.items);
          setResult(current => {
            const merged = append && current ? [...current.items, ...items] : items;
            return markRequests({
              ...last,
              items: merged,
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
    })();
    return () => controller.abort();
  }, [user, owner, generation, mode, personRef, degree, query, searchPending, page, revision, retry, memoryKey, scope]);

  useEffect(() => { if (result && !busy && !error) onReady?.(); }, [result, busy, error, onReady]);

  useEffect(() => {
    const retained = restoreSnapshot.current;
    if (!result || busy || !restore.current || !retained) return;
    restore.current = false;
    const scroll = root.current?.closest<HTMLElement>("[data-network-scroll-owner]");
    const frame = requestAnimationFrame(() => {
      if (scroll) scroll.scrollTop = retained.scrollTop;
      const controls = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("button[data-network-person]") ?? []).filter(element => element.dataset.networkPerson === retained.focusRef);
      const target = controls.find(element => (element.dataset.networkFocus ?? "profile") === (retained.focusControl ?? "profile"))
        ?? controls.find(element => !element.dataset.networkFocus);
      const fallback = root.current?.querySelector<HTMLInputElement>("input") ?? root.current;
      (target ?? fallback)?.focus({ preventScroll: true });
    });
    const cancel = !scroll ? restoreConnectListScroll(retained.scrollTop) : undefined;
    return () => { cancelAnimationFrame(frame); cancel?.(); };
  }, [result, busy]);

  const title = mode === "discovery" ? "Explore your network" : mode === "mutuals" ? `${result?.totalCount ?? ""} mutual ${result?.totalCount === 1 ? "connection" : "connections"}`.trim() : result?.person ? `${connectPersonName(result.person)}’s connections` : "Connections";
  const remember = (personRef: string, focusControl: "profile" | "mutual" | "request" | "connect" = "profile") => {
    const scrollTop = root.current?.closest<HTMLElement>("[data-network-scroll-owner]")?.scrollTop ?? connectListScrollTop();
    snapshot.current = { query: draftQuery, degree, page: result?.page ?? page, scrollTop, focusRef: personRef, focusControl };
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
  return <section ref={root} tabIndex={-1} className={cn("mx-auto w-full min-w-0 max-w-[880px] space-y-3 sm:space-y-4", !embedded && "px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-5")} data-testid={mode === "mutuals" ? "mutual-connections-list" : "network-people-list"}>
    <header className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
      {!embedded || mode !== "discovery" ? <Heading data-connect-role="section">{title}</Heading> : null}
      <p data-connect-role="description" className="max-w-prose text-sm leading-snug text-muted-foreground">{mode === "mutuals" ? `People connected to both you${result?.person ? ` and ${connectPersonName(result.person)}` : " and this person"}.` : mode === "connections" ? "This person has allowed their direct connections to browse this list." : extended ? "Third-degree connections and suggested people." : "Find people through connections that allow discovery."}</p>
      {mode === "mutuals" && result?.hasMore && result.totalCount !== undefined ? <p data-connect-role="description" className="text-sm text-muted-foreground">Showing {result.items.length} of {result.totalCount}</p> : null}
    </header>
    {mode !== "mutuals" ? (
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label={extended ? "Search people by name" : "Search network by name"} placeholder="Search by name" value={draftQuery} className="ps-9" maxLength={160}
          onChange={event => {
            const nextQuery = event.target.value;
            setDraftQuery(nextQuery);
            if (nextQuery.trim() === draftQuery.trim()) return;
            ++requestRef.current;
            restore.current = false;
            firstPages.current = null;
            setResult(null);
            setBusy(true);
            setError(null);
            setPage(1);
          }} />
      </div>
    ) : null}
    {mode === "discovery" ? (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Connection degree filters">
        {networkFilters.map(value => (
          <button
            data-connect-role="action"
            key={value ?? "all"}
            type="button"
            aria-pressed={degree === value}
            className="min-h-11 min-w-0 rounded-full border px-2 py-1.5 text-xs leading-tight [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground min-[360px]:text-sm sm:px-3"
            onClick={() => {
              if (value === degree) return;
              ++requestRef.current;
              restore.current = false;
              const scroller = root.current?.closest<HTMLElement>("[data-network-scroll-owner]");
              if (scroller) scroller.scrollTop = 0;
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
    {busy && !result ? <p data-connect-role="description" role="status" className="py-3 text-sm text-muted-foreground">Loading connections…</p> : null}
    {error ? <div role="alert" className="space-y-2"><p data-connect-role="description">{error}</p><button data-connect-role="action" type="button" className="min-h-11 rounded-full border px-4" onClick={() => setRetry(value => value + 1)}>Try again</button></div> : null}
    {people.length ? <ul className="divide-y rounded-xl border bg-card" aria-busy={busy} aria-label={extended ? "Extended network people" : undefined}>
      {people.map(person => <NetworkPersonRow key={person.publicPersonRef} person={person}
        connecting={connecting.has(person.publicPersonRef)} connectionError={connectionErrors[person.publicPersonRef]}
        onConnect={() => void connect(person.publicPersonRef)} onRemember={() => remember(person.publicPersonRef, "mutual")} onOpen={element => {
        remember(person.publicPersonRef, element.dataset.networkFocus === "request" ? "request" : "profile");
        openPersonProfilePreview({ personRef: person.publicPersonRef }, element);
      }} />)}
    </ul> : null}
    {result && !busy && !people.length ? <div className="py-3 text-sm text-muted-foreground">
      <p data-connect-role="description" role="status">{extended && !query.trim()
        ? "No people to show right now. Check back as more people join."
        : `No profiles to show${query.trim() ? " for this name" : " right now"}.`}</p>
      {extended && !query.trim() && onDismiss ? <button data-connect-role="action" type="button"
        data-voice-control-id="network-find-people"
        className="min-h-11 rounded-md text-primary hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onDismiss}>Back to Find people</button> : null}
    </div> : null}
    {result && !result.hasMore && result.totalCount !== undefined && result.items.length < result.totalCount ? <p data-connect-role="description" className="text-sm text-muted-foreground">Some mutual connections are unavailable to view.</p> : null}
    {extended && result && people.length > 0 && !result.hasMore && !error ? <p data-connect-role="description" role="status" className="text-sm text-muted-foreground">You’ve reached the end of this list.</p> : null}
    {result?.hasMore && !error ? <button data-connect-role="action" type="button" className="min-h-11 rounded-full border px-5" disabled={busy} onClick={() => setPage(result.page + 1)}>{mode === "mutuals" ? "Load more mutual connections" : extended ? "Load more people" : "Load more connections"}</button> : null}
  </section>;
}
