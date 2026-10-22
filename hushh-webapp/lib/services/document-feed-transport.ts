/**
 * Platform adapters for the document-feed stream
 * (lib/feed/document-feed-stream-manager.ts holds the state machine).
 *
 * Web: GET /api/one/feed/events?v=2 straight from the backend origin with the
 * Firebase ID token. It holds no Next.js slot and has no 120-300 s web-server
 * timeout. When the browser cannot use it (CORS or network failure, no headers
 * in 7 s, 404 disabled, 503 busy) the same attempt falls back to the
 * same-origin proxy /api/consent/document-feed/{uid}?v=2, whose streams the
 * server ends before the web server's request timeout; the direct route is
 * then skipped for a while. Both paths use raw fetch, bypassing apiFetch's 401
 * replay, so a stream 401 can never sign anyone out. One tab per browser
 * streams (navigator.locks); the others receive its frames over a
 * BroadcastChannel. Without both APIs every tab streams on its own.
 *
 * Native: GET /api/consent/document-feed/{uid}?v=2 through the HushhStream
 * plugin (nativeStreamFetch), which really streams and really cancels, so a
 * backgrounded app frees its backend slot. Never buffered CapacitorHttp.
 */
import { getDirectBackendUrl } from "@/lib/services/api-service";
import { nativeStreamFetch } from "@/lib/services/native-sse-fetch";
import type {
  DocumentFeedOpenResult,
  DocumentFeedTransport,
  FeedRelayMessage,
  FeedStreamCoordinator,
} from "@/lib/feed/document-feed-stream-manager";

export type DocumentFeedPlatform = "web" | "native";

export const DOCUMENT_FEED_WEB_PATH = "/api/one/feed/events?v=2";
export const DOCUMENT_FEED_DIRECT_HEADERS_TIMEOUT_MS = 7_000;
/** How long the web skips the direct route after it failed, by cause. */
export const DOCUMENT_FEED_DIRECT_SKIP_MS = {
  network: 5 * 60_000,
  disabled: 30 * 60_000,
  busy: 60_000,
} as const;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** The fixed owner stream: native calls it on the backend, the web through the Next proxy. */
export function documentFeedStreamPath(uid: string): string {
  return `/api/consent/document-feed/${encodeURIComponent(uid)}?v=2`;
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  if (/^\d{1,6}$/.test(raw)) return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}

function streamHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "text/event-stream" };
}

function toOpenResult(response: Response): DocumentFeedOpenResult {
  const ok = response.status >= 200 && response.status < 300;
  if (!ok && response.body) void response.body.cancel().catch(() => undefined);
  return {
    status: response.status,
    body: ok ? response.body : null,
    retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
  };
}

function directOrigin(): string | null {
  const origin = getDirectBackendUrl().replace(/\/+$/, "");
  // Never a relative URL: the direct route exists to avoid the web server.
  return /^https?:\/\//i.test(origin) ? origin : null;
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function createWebTransport(now: () => number): DocumentFeedTransport {
  let directSkippedUntil = 0;

  /** The direct response, or null when this attempt should use the proxy. */
  const openDirect = async (origin: string, token: string, signal: AbortSignal): Promise<Response | null> => {
    const controller = new AbortController();
    // Cancelling the attempt cancels the direct request and its body.
    signal.addEventListener("abort", () => controller.abort(), { once: true });
    const timer = setTimeout(() => controller.abort(), DOCUMENT_FEED_DIRECT_HEADERS_TIMEOUT_MS);
    try {
      const response = await fetch(`${origin}${DOCUMENT_FEED_WEB_PATH}`, {
        method: "GET",
        headers: streamHeaders(token),
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
      if (response.status !== 404 && response.status !== 503) return response;
      void response.body?.cancel().catch(() => undefined);
      const skip = response.status === 404
        ? DOCUMENT_FEED_DIRECT_SKIP_MS.disabled
        : Math.max(
          parseRetryAfterMs(response.headers.get("retry-after"), now()) ?? 0,
          DOCUMENT_FEED_DIRECT_SKIP_MS.busy,
        );
      directSkippedUntil = now() + skip;
      return null;
    } catch (error) {
      // An abandoned attempt, or no network at all, is not the route's fault.
      if (signal.aborted || isOffline()) throw error;
      directSkippedUntil = now() + DOCUMENT_FEED_DIRECT_SKIP_MS.network;
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async open({ uid, token, signal }) {
      const origin = directOrigin();
      if (origin && now() >= directSkippedUntil) {
        const direct = await openDirect(origin, token, signal);
        if (direct) return toOpenResult(direct);
      }
      const proxied = await fetch(documentFeedStreamPath(uid), {
        method: "GET",
        headers: streamHeaders(token),
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      return toOpenResult(proxied);
    },
  };
}

const nativeTransport: DocumentFeedTransport = {
  async open({ uid, token, signal }) {
    const response = await nativeStreamFetch(documentFeedStreamPath(uid), {
      method: "GET",
      headers: streamHeaders(token),
      cache: "no-store",
      signal,
    });
    return toOpenResult(response);
  },
};

/** One transport per stream manager; the web one remembers a failing direct route. */
export function createDocumentFeedTransport(
  platform: DocumentFeedPlatform,
  now: () => number = () => Date.now(),
): DocumentFeedTransport {
  return platform === "native" ? nativeTransport : createWebTransport(now);
}

export type FeedLockManager = {
  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>): Promise<unknown>;
};

export type FeedChannel = {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

export type FeedCoordinatorEnvironment = {
  locks: FeedLockManager | null;
  openChannel: ((name: string) => FeedChannel) | null;
};

function browserEnvironment(): FeedCoordinatorEnvironment {
  const locks =
    typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function"
      ? navigator.locks
      : null;
  const openChannel =
    typeof BroadcastChannel === "undefined" ? null : (name: string) => new BroadcastChannel(name);
  return { locks, openChannel };
}

type CoordinatorSession = {
  channel: FeedChannel | null;
  listener: ((event: MessageEvent) => void) | null;
  lockRequest: AbortController | null;
  releaseLock: (() => void) | null;
  leading: boolean;
};

function closeChannel(session: CoordinatorSession): void {
  if (session.channel && session.listener) session.channel.removeEventListener("message", session.listener);
  try {
    session.channel?.close();
  } catch {
    // Already closed.
  }
  session.channel = null;
  session.listener = null;
}

/**
 * One leader tab per browser and account; followers hear its frames. Each
 * join is its own session, so a tab that leaves (hidden) and joins again
 * (visible) can never act on its earlier lock request.
 */
export function createFeedStreamCoordinator(
  uid: string,
  platform: DocumentFeedPlatform,
  environment: FeedCoordinatorEnvironment = browserEnvironment(),
): FeedStreamCoordinator {
  const name = `hussh-feed-stream:${uid}`;
  let session: CoordinatorSession | null = null;

  const end = (ended: CoordinatorSession) => {
    ended.leading = false;
    ended.lockRequest?.abort();
    ended.lockRequest = null;
    ended.releaseLock?.();
    ended.releaseLock = null;
    closeChannel(ended);
  };

  return {
    join({ onRole, onMessage }) {
      if (session) end(session);
      const current: CoordinatorSession = {
        channel: null,
        listener: null,
        lockRequest: null,
        releaseLock: null,
        leading: false,
      };
      session = current;
      const active = () => session === current;
      const lead = () => {
        if (!active() || current.leading) return;
        current.leading = true;
        onRole("leader");
      };
      const { locks, openChannel } = environment;
      if (platform === "native" || !locks || !openChannel) {
        lead();
        return;
      }
      try {
        current.channel = openChannel(name);
      } catch {
        current.channel = null;
        lead();
        return;
      }
      current.listener = (event) => {
        if (active()) onMessage(event.data);
      };
      current.channel.addEventListener("message", current.listener);
      onRole("follower");
      current.lockRequest = new AbortController();
      locks
        .request(name, { signal: current.lockRequest.signal }, () => {
          if (!active()) return Promise.resolve();
          // Hold the lock until this session ends (or the tab closes).
          return new Promise<void>((resolve) => {
            current.releaseLock = resolve;
            lead();
          });
        })
        .catch(() => {
          if (!active() || current.leading) return;
          // Web Locks refused: stream alone and relay nothing, so no tab
          // ever applies a frame twice.
          closeChannel(current);
          lead();
        });
    },
    post(message: FeedRelayMessage) {
      try {
        session?.channel?.postMessage(message);
      } catch {
        // A closed channel simply has nobody left to tell.
      }
    },
    leave() {
      if (!session) return;
      const ended = session;
      session = null;
      end(ended);
    },
  };
}

/**
 * Calls onChange when Firebase issues a new ID token for this account (web).
 * Loaded on demand: the stream watches only while it is blocked on auth.
 */
export function observeIdTokenChanges(uid: string, onChange: () => void): () => void {
  let cancelled = false;
  let unsubscribe: (() => void) | null = null;
  void Promise.all([import("firebase/auth"), import("@/lib/firebase/config")])
    .then(([{ onIdTokenChanged }, { auth }]) => {
      if (cancelled) return;
      let current = true;
      unsubscribe = onIdTokenChanged(auth, (user) => {
        // The first callback reports the token already in use.
        if (current) {
          current = false;
          return;
        }
        if (user?.uid === uid) onChange();
      });
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    unsubscribe?.();
    unsubscribe = null;
  };
}
