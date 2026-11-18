"use client";

import { getAuthSessionGeneration, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { subscribeToConnectionGraphChanges } from "@/lib/connections/connection-graph-events";
import { ConnectionsService, type NetworkDegree, type NetworkPage } from "@/lib/services/connections-service";
import { DIRECTORY_PASSIVE_REFRESH_AFTER_MS } from "./directory-first-page-cache";

const MAX_PAGES = 48;
export const NETWORK_FILTERS = [undefined, 1, 2, 3] as const;
export type NetworkListMode = "mutuals" | "connections" | "discovery";
export type NetworkPageRead = {
  mode: NetworkListMode;
  personRef?: string;
  degree?: NetworkDegree;
  query: string;
  page: number;
};

function keyFor(read: NetworkPageRead) {
  return JSON.stringify([read.mode, read.personRef, read.degree, read.query, read.page]);
}

/** Memory owned by an authenticated discovery session or an open preview journey. */
export class NetworkPageCache {
  private readonly generation = getAuthSessionGeneration();
  private readonly pages = new Map<string, { data: NetworkPage; readAt: number }>();
  private readonly pending = new Map<string, { promise: Promise<NetworkPage>; abort: AbortController }>();

  peek(read: NetworkPageRead): NetworkPage | undefined {
    const value = this.pages.get(keyFor(read));
    if (this.generation === getAuthSessionGeneration() && value && Date.now() - value.readAt < DIRECTORY_PASSIVE_REFRESH_AFTER_MS) return value.data;
  }

  load(read: NetworkPageRead, getToken: () => Promise<string>, renew = false): Promise<NetworkPage> {
    const key = keyFor(read);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight.promise;
    const cached = !renew && this.peek(read);
    if (cached) return Promise.resolve(cached);
    const abort = new AbortController();
    const isCurrent = () => !abort.signal.aborted && this.generation === getAuthSessionGeneration();
    const promise = Promise.resolve().then(getToken).then(idToken => {
      if (!isCurrent()) throw new DOMException("Network session changed", "AbortError");
      const { mode, personRef, degree, query, page } = read;
      return mode === "mutuals" && personRef
        ? ConnectionsService.listMutualConnections({ idToken, personRef, page, signal: abort.signal })
        : ConnectionsService.listNetwork({
          idToken, personRef: mode === "connections" ? personRef : undefined, degree, query, page,
          includeSuggestions: mode === "discovery" && degree === 3, signal: abort.signal,
        });
    }).then(data => {
      if (!isCurrent()) throw new DOMException("Network session changed", "AbortError");
      this.pages.delete(key);
      this.pages.set(key, { data, readAt: Date.now() });
      if (this.pages.size > MAX_PAGES) this.pages.delete(this.pages.keys().next().value!);
      return data;
    }).finally(() => {
      if (this.pending.get(key)?.abort === abort) this.pending.delete(key);
    });
    this.pending.set(key, { promise, abort });
    return promise;
  }

  clear() {
    for (const { abort } of this.pending.values()) abort.abort();
    this.pending.clear();
    this.pages.clear();
  }
}

let discovery: { owner: string; generation: ReturnType<typeof getAuthSessionGeneration>; cache: NetworkPageCache } | undefined;
let subscribed = false;

export function discoveryNetworkPages(owner: string): NetworkPageCache {
  const generation = getAuthSessionGeneration();
  if (!discovery || discovery.owner !== owner || discovery.generation !== generation) {
    discovery?.cache.clear();
    discovery = { owner, generation, cache: new NetworkPageCache() };
  }
  if (!subscribed) {
    subscribed = true;
    subscribeAuthSessionGeneration(() => {
      discovery?.cache.clear();
      discovery = undefined;
    });
    subscribeToConnectionGraphChanges(event => {
      if (discovery?.owner === event.userId) discovery.cache.clear();
    });
  }
  return discovery.cache;
}

export function preloadNetworkDiscovery(owner: string, getToken: () => Promise<string>): void {
  const cache = discoveryNetworkPages(owner);
  let token: Promise<string> | undefined;
  const tokenForBrowse = () => token ??= getToken();
  const firstPage = (degree?: NetworkDegree) => cache.load({ mode: "discovery", query: "", page: 1, degree }, tokenForBrowse);
  void firstPage().then(() => {
    if (discovery?.cache !== cache) return;
    for (const degree of NETWORK_FILTERS) if (degree) void firstPage(degree).catch(() => {});
  }).catch(() => {});
}
