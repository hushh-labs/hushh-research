/**
 * Platform adapters for the document-feed stream
 * (lib/feed/document-feed-stream-manager.ts holds the state machine).
 *
 * Web: GET /api/one/feed/events?v=2 straight from the backend origin with the
 * Firebase ID token. It holds no Next.js proxy slot, and it bypasses apiFetch's
 * 401 replay, so a stream 401 can never sign anyone out. One tab per browser
 * streams (navigator.locks); the others receive its frames over a
 * BroadcastChannel. Without both APIs every tab streams on its own.
 *
 * Native: GET /api/consent/document-feed/{uid}?v=2 through the HushhStream
 * plugin (nativeStreamFetch), which really streams and really cancels, so a
 * backgrounded app frees its backend slot.
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
const MAX_RETRY_AFTER_MS = 60 * 60_000;

export function documentFeedNativePath(uid: string): string {
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

const webTransport: DocumentFeedTransport = {
  async open({ token, signal }) {
    const origin = getDirectBackendUrl().replace(/\/+$/, "");
    // Never fall back to a relative URL: that would hold a web-server slot.
    if (!/^https?:\/\//i.test(origin)) return { status: 404, body: null, retryAfterMs: null };
    const response = await fetch(`${origin}${DOCUMENT_FEED_WEB_PATH}`, {
      method: "GET",
      headers: streamHeaders(token),
      cache: "no-store",
      credentials: "omit",
      signal,
    });
    return toOpenResult(response);
  },
};

const nativeTransport: DocumentFeedTransport = {
  async open({ uid, token, signal }) {
    const response = await nativeStreamFetch(documentFeedNativePath(uid), {
      method: "GET",
      headers: streamHeaders(token),
      signal,
    });
    return toOpenResult(response);
  },
};

export function createDocumentFeedTransport(platform: DocumentFeedPlatform): DocumentFeedTransport {
  return platform === "native" ? nativeTransport : webTransport;
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

/** One leader tab per browser and account; followers hear its frames. */
export function createFeedStreamCoordinator(
  uid: string,
  platform: DocumentFeedPlatform,
  environment: FeedCoordinatorEnvironment = browserEnvironment(),
): FeedStreamCoordinator {
  const name = `hussh-feed-stream:${uid}`;
  let channel: FeedChannel | null = null;
  let listener: ((event: MessageEvent) => void) | null = null;
  let lockRequest: AbortController | null = null;
  let releaseLock: (() => void) | null = null;
  let leading = false;
  let left = false;

  const closeChannel = () => {
    if (channel && listener) channel.removeEventListener("message", listener);
    try {
      channel?.close();
    } catch {
      // Already closed.
    }
    channel = null;
    listener = null;
  };

  return {
    join({ onRole, onMessage }) {
      left = false;
      const lead = () => {
        if (left || leading) return;
        leading = true;
        onRole("leader");
      };
      const { locks, openChannel } = environment;
      if (platform === "native" || !locks || !openChannel) {
        lead();
        return;
      }
      try {
        channel = openChannel(name);
      } catch {
        channel = null;
        lead();
        return;
      }
      listener = (event) => onMessage(event.data);
      channel.addEventListener("message", listener);
      onRole("follower");
      lockRequest = new AbortController();
      locks
        .request(name, { signal: lockRequest.signal }, () => {
          if (left) return Promise.resolve();
          // Hold the lock until this tab leaves (or closes).
          return new Promise<void>((resolve) => {
            releaseLock = resolve;
            lead();
          });
        })
        .catch(() => {
          if (left || leading) return;
          // Web Locks refused: stream alone and relay nothing, so no tab
          // ever applies a frame twice.
          closeChannel();
          lead();
        });
    },
    post(message: FeedRelayMessage) {
      try {
        channel?.postMessage(message);
      } catch {
        // A closed channel simply has nobody left to tell.
      }
    },
    leave() {
      left = true;
      leading = false;
      lockRequest?.abort();
      lockRequest = null;
      releaseLock?.();
      releaseLock = null;
      closeChannel();
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
