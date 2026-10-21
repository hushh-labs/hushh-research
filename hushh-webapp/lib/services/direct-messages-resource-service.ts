import { CACHE_KEYS, CacheService } from "./cache-service";
import type { DirectMessage, DirectMessageConversation } from "./direct-messages-service";

export type DirectMessageSelection = { kind: "conversation" | "person"; ref: string };
export type DirectMessageThread = {
  conversation: DirectMessageConversation | null;
  peerPersonRef: string | null;
  peerDisplayName: string | null;
  peerPhotoUrl: string | null;
  canSend: boolean;
  disconnectedNotice: string | null;
  nextBefore: string | null;
};
type ThreadSnapshot = { selection: string; thread: DirectMessageThread; messages: DirectMessage[]; savedAt: number };
type RouteSnapshot = DirectMessageSelection & { token: string; savedAt: number };
const TTL = 5 * 60_000;
const cache = () => CacheService.getInstance();

/** Presentation snapshots only. Never persists bodies, credentials or send authority. */
export class DirectMessagesResourceService {
  /** A purge invalidates outstanding writers as well as stored snapshots. */
  static beginRequest(owner: string): object {
    const key = CACHE_KEYS.DIRECT_MESSAGE_SESSION(owner);
    const existing = cache().get<object>(key);
    if (existing) return existing;
    const session = {};
    cache().set(key, session, TTL);
    return session;
  }

  static readThread(owner: string, selection: string): ThreadSnapshot | null {
    const entry = cache().get<ThreadSnapshot[]>(CACHE_KEYS.DIRECT_MESSAGE_THREADS(owner))
      ?.find((item) => item.selection === selection && Date.now() - item.savedAt <= TTL);
    return entry ?? null;
  }

  static writeThread(owner: string, session: object, selection: string, thread: DirectMessageThread, messages: DirectMessage[]): void {
    if (cache().get(CACHE_KEYS.DIRECT_MESSAGE_SESSION(owner)) !== session) return;
    const key = CACHE_KEYS.DIRECT_MESSAGE_THREADS(owner);
    const previous = cache().get<ThreadSnapshot[]>(key) ?? [];
    // Keep the most recent window; the existing history endpoint can page back
    // from its oldest row if a larger loaded transcript was evicted.
    const window = messages.slice(-600);
    const snapshot: ThreadSnapshot = {
      selection, savedAt: Date.now(), messages: window,
      thread: { ...thread, canSend: false, nextBefore: messages.length > window.length ? window[0]!.id : thread.nextBefore },
    };
    const aliases = new Set([selection, ...(thread.conversation ? [`conversation:${thread.conversation.id}`] : []),
      ...(thread.peerPersonRef ? [`person:${thread.peerPersonRef}`] : [])]);
    cache().set(key, [...previous.filter((item) => !aliases.has(item.selection) && Date.now() - item.savedAt <= TTL),
      ...[...aliases].map((alias) => ({ ...snapshot, selection: alias }))].slice(-24), TTL);
  }

  static readRoute(owner: string, token: string): DirectMessageSelection | null {
    const entry = cache().get<RouteSnapshot[]>(CACHE_KEYS.DIRECT_MESSAGE_ROUTES(owner))
      ?.find((item) => item.token === token && Date.now() - item.savedAt <= TTL);
    return entry ? { kind: entry.kind, ref: entry.ref } : null;
  }

  static writeRoute(owner: string, session: object, route: DirectMessageSelection & { token: string }): void {
    if (cache().get(CACHE_KEYS.DIRECT_MESSAGE_SESSION(owner)) !== session) return;
    const key = CACHE_KEYS.DIRECT_MESSAGE_ROUTES(owner);
    const previous = cache().get<RouteSnapshot[]>(key) ?? [];
    cache().set(key, [...previous.filter((item) => item.token !== route.token && Date.now() - item.savedAt <= TTL),
      { ...route, savedAt: Date.now() }].slice(-64), TTL);
  }
}
