import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportMocks = vi.hoisted(() => ({
  nativeStreamFetch: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  getDirectBackendUrl: () => "https://backend.test/",
  ApiService: { apiFetchStream: vi.fn() },
}));
vi.mock("@/lib/services/native-sse-fetch", () => ({
  nativeStreamFetch: transportMocks.nativeStreamFetch,
}));

import { AUTH_SESSION_INVALIDATED_EVENT } from "@/lib/auth/session-invalidation";
import {
  createDocumentFeedStreamManager,
  DOCUMENT_FEED_AUTH_RECOVERY_WINDOW_MS,
  DOCUMENT_FEED_POLLING_RETRY_MS,
  DOCUMENT_FEED_WATCHDOG_MS,
  type DocumentFeedOpenResult,
  type DocumentFeedStreamDeps,
  type FeedRelayMessage,
  type FeedStreamCoordinator,
  type FeedStreamRole,
} from "@/lib/feed/document-feed-stream-manager";
import { PAYOUT_KINDS } from "@/lib/payouts/payout-events";
import {
  createDocumentFeedTransport,
  createFeedStreamCoordinator,
  type FeedChannel,
  type FeedCoordinatorEnvironment,
} from "@/lib/services/document-feed-transport";

const REQUEST = "11111111-2222-4333-8444-555555555555";
const OTHER_REQUEST = "22222222-3333-4444-8555-666666666666";
const HELLO = 'event: hello\ndata: {"v":2,"heartbeat_ms":15000,"max_lifetime_ms":840000,"live":true}\n\n';
const RESET = "event: feed_reset\ndata: {}\n\n";
const changed = (id: string) => `event: feed_changed\nid: e\ndata: {"request_id":"${id}"}\n\n`;
const PAYOUT = `event: payout_changed\ndata: {"kinds":["wallet"],"request_ids":["${REQUEST}"]}\n\n`;
const ALL_KINDS = [...PAYOUT_KINDS];
const FULL = { general: true, consent: true };
const targeted = (requestId: string) => ({ general: false, consent: true, requestId });
const encoder = new TextEncoder();

type FakeStream = { push(text: string): void; close(): void; signal: AbortSignal };

function fakeTransport() {
  const streams: FakeStream[] = [];
  const queue: Array<DocumentFeedOpenResult | Error> = [];
  const open = vi.fn(async ({ signal }: { uid: string; token: string; signal: AbortSignal }) => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
    streams.push({
      push: (text) => controller.enqueue(encoder.encode(text)),
      close: () => controller.close(),
      signal,
    });
    return { status: 200, body, retryAfterMs: null };
  });
  return { open, queue, streams, last: () => streams[streams.length - 1]! };
}

const status = (code: number, retryAfterMs: number | null = null): DocumentFeedOpenResult => ({
  status: code,
  body: null,
  retryAfterMs,
});

function soloCoordinator(): FeedStreamCoordinator & { posts: FeedRelayMessage[] } {
  const posts: FeedRelayMessage[] = [];
  return { posts, join: ({ onRole }) => onRole("leader"), post: (message) => posts.push(message), leave: () => {} };
}

function setup(overrides: Partial<DocumentFeedStreamDeps> = {}) {
  const transport = fakeTransport();
  const deps = {
    uid: "owner",
    transport,
    coordinator: soloCoordinator(),
    getToken: vi.fn(async (forceRefresh: boolean) => (forceRefresh ? "fresh-token" : "token")),
    dispatchFeed: vi.fn(),
    dispatchPayout: vi.fn(),
    onStreamState: vi.fn(),
    random: () => 0.5,
    ...overrides,
  };
  const manager = createDocumentFeedStreamManager(deps);
  return { manager, transport, deps };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const lastState = (deps: { onStreamState: ReturnType<typeof vi.fn> }) => deps.onStreamState.mock.lastCall?.[0];
const stallCalls = (deps: { dispatchPayout: ReturnType<typeof vi.fn> }) =>
  deps.dispatchPayout.mock.calls.filter(([detail]) => detail.source === "stall");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("document feed stream manager", () => {
  it("sends typed payout frames to the payout bus only and goes live on hello", async () => {
    const { manager, transport, deps } = setup();
    manager.start();
    await tick();
    const stream = transport.last();
    stream.push(HELLO + RESET);
    await tick();
    expect(deps.onStreamState.mock.calls.map(([state]) => state)).toEqual(["reconnecting", "live"]);
    expect(deps.dispatchFeed).toHaveBeenCalledExactlyOnceWith(FULL);
    expect(deps.dispatchPayout).toHaveBeenCalledExactlyOnceWith({ kinds: ALL_KINDS, source: "sse_reset" });

    await tick(10_000);
    deps.dispatchFeed.mockClear();
    deps.dispatchPayout.mockClear();
    stream.push(PAYOUT);
    await tick(10_000);
    expect(deps.dispatchPayout).toHaveBeenCalledExactlyOnceWith({
      kinds: ["wallet"],
      requestIds: [REQUEST],
      source: "sse",
    });
    expect(deps.dispatchFeed).not.toHaveBeenCalled();

    stream.push('event: heartbeat\ndata: {"ts":1,"live":false}\n\n');
    await tick();
    expect(lastState(deps)).toBe("reconnecting");
    stream.push('event: heartbeat\ndata: {"ts":2,"live":true}\n\n');
    await tick();
    expect(lastState(deps)).toBe("live");
    manager.stop();
    expect(stream.signal.aborted).toBe(true);
    expect(lastState(deps)).toBe("polling");
  });

  it("rereads the Feed on a burst's first frame and once after it settles, widening mixed requests", async () => {
    const { manager, transport, deps } = setup();
    manager.start();
    await tick();
    const stream = transport.last();
    stream.push(HELLO + changed(REQUEST) + 'event: feed_changed\ndata: {"request_id":"../../other"}\n\n');
    await tick();
    expect(deps.dispatchFeed.mock.calls).toEqual([[targeted(REQUEST)]]);
    // The trailing reread catches a change that a joined in-flight read predates.
    await tick(10_000);
    expect(deps.dispatchFeed.mock.calls).toEqual([[targeted(REQUEST)], [targeted(REQUEST)]]);

    deps.dispatchFeed.mockClear();
    stream.push(changed(REQUEST));
    await tick(900);
    stream.push(changed(OTHER_REQUEST));
    await tick(999);
    expect(deps.dispatchFeed).toHaveBeenCalledTimes(1);
    await tick(1);
    // Different requests in one burst widen the trailing reread to the account.
    expect(deps.dispatchFeed.mock.calls).toEqual([[targeted(REQUEST)], [{ general: false, consent: true }]]);

    // A general Feed write rereads the Feed without the consent cascade, and
    // never widens a request-narrowed consent reread.
    deps.dispatchFeed.mockClear();
    stream.push('event: feed_changed\ndata: {}\n\n' + changed(REQUEST));
    await tick(10_000);
    expect(deps.dispatchFeed.mock.calls).toEqual([
      [{ general: true, consent: false }],
      [{ general: true, consent: true, requestId: REQUEST }],
    ]);
    expect(deps.dispatchPayout).toHaveBeenCalledTimes(0);
    deps.dispatchFeed.mockClear();
    stream.push('event: feed_changed\ndata: {}\n\n' + 'event: feed_changed\ndata: {"reason":"history_mutated","content":"discard"}\n\n');
    await tick(10_000);
    expect(deps.dispatchFeed.mock.calls).toEqual([
      [{ general: true, consent: false }],
      [{ general: true, consent: false, historyMutated: true }],
    ]);
    deps.dispatchFeed.mockClear();
    stream.push('event: feed_changed\ndata: {"reason":"history_mutated"}\n\n');
    await tick(10_000);
    expect(deps.dispatchFeed.mock.calls).toEqual([
      [{ general: true, consent: false, historyMutated: true }],
      [{ general: true, consent: false, historyMutated: true }],
    ]);
    manager.stop();
  });

  it("repairs the Feed on the periodic clock only while no healthy stream covers this tab", async () => {
    const { manager, transport, deps } = setup();
    manager.start();
    await tick();
    transport.last().push(HELLO);
    await tick();
    manager.repairIfUncovered();
    expect(deps.dispatchFeed).not.toHaveBeenCalled();

    transport.last().close();
    await tick();
    expect(manager.phase()).toBe("backoff");
    manager.repairIfUncovered();
    expect(deps.dispatchFeed).toHaveBeenCalledExactlyOnceWith(FULL);
    // Not a burst: the clock itself is the next reread.
    await tick(10);
    expect(deps.dispatchFeed).toHaveBeenCalledTimes(1);

    manager.visibility(false);
    manager.repairIfUncovered();
    expect(deps.dispatchFeed).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("aborts a silent attempt after 45 s, rereads payouts once and reconnects at once", async () => {
    const { manager, transport, deps } = setup();
    manager.start();
    await tick();
    const first = transport.last();
    first.push(HELLO);
    // Comments alone keep a healthy stream alive.
    for (let ping = 0; ping < 8; ping += 1) {
      first.push(": ping - 2026-10-11 00:00:00\n\n");
      await tick(15_000);
    }
    expect(transport.open).toHaveBeenCalledTimes(1);
    await tick(DOCUMENT_FEED_WATCHDOG_MS - 15_000 - 1);
    expect(first.signal.aborted).toBe(false);
    await tick(1);
    expect(first.signal.aborted).toBe(true);
    expect(stallCalls(deps)).toEqual([[{ kinds: ALL_KINDS, source: "stall" }]]);
    // Fake timers run a 0 ms timer created mid-tick 1 ms later.
    await tick(1);
    expect(transport.open).toHaveBeenCalledTimes(2);

    // Still silent: reconnect again, but do not reread payouts again.
    await tick(DOCUMENT_FEED_WATCHDOG_MS + 1);
    expect(transport.open).toHaveBeenCalledTimes(3);
    expect(stallCalls(deps)).toHaveLength(1);
    manager.stop();
  });

  it("claims live only while v2 frames flow, not on pings alone", async () => {
    const { manager, transport, deps } = setup();
    manager.start();
    await tick();
    const stream = transport.last();
    stream.push(HELLO);
    await tick();
    expect(lastState(deps)).toBe("live");
    for (let ping = 0; ping < 5; ping += 1) {
      stream.push(": ping\n\n");
      await tick(15_000);
    }
    expect(lastState(deps)).toBe("reconnecting");
    expect(stream.signal.aborted).toBe(false);
    stream.push('event: heartbeat\ndata: {"ts":3,"live":true}\n\n');
    await tick();
    expect(lastState(deps)).toBe("live");
    expect(transport.open).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("backs off 1/2/4/8/16/30 s, then polls every 5 min after 8 failures", async () => {
    const { manager, transport, deps } = setup();
    transport.open.mockRejectedValue(new TypeError("Failed to fetch"));
    manager.start();
    await tick();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const before = transport.open.mock.calls.length;
      await tick(delay - 1);
      expect(transport.open).toHaveBeenCalledTimes(before);
      await tick(1);
      expect(transport.open).toHaveBeenCalledTimes(before + 1);
    }
    expect(transport.open).toHaveBeenCalledTimes(8);
    expect(lastState(deps)).toBe("polling");
    await tick(DOCUMENT_FEED_POLLING_RETRY_MS - 1);
    expect(transport.open).toHaveBeenCalledTimes(8);
    await tick(1);
    expect(transport.open).toHaveBeenCalledTimes(9);

    // Polling retries early on focus, visibility or network, never in a burst.
    manager.focus();
    await tick();
    expect(transport.open).toHaveBeenCalledTimes(9);
    await tick(10_000);
    manager.visibility(true);
    await tick();
    expect(transport.open).toHaveBeenCalledTimes(10);
    manager.online();
    await tick();
    expect(transport.open).toHaveBeenCalledTimes(11);
    manager.stop();
  });

  it.each([
    [0, 800],
    [0.999_999, 1_200],
  ])("jitters each step by at most 20%% (random %s)", async (random, firstDelay) => {
    const { manager, transport } = setup({ random: () => random });
    transport.open.mockRejectedValue(new TypeError("Failed to fetch"));
    manager.start();
    await tick(firstDelay - 1);
    expect(transport.open).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(transport.open).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it("resets backoff after 60 s healthy and treats a reconnect frame as rotation, not failure", async () => {
    const { manager, transport } = setup();
    transport.queue.push(new TypeError("down"), new TypeError("down"), new TypeError("down"));
    manager.start();
    await tick(1_000 + 2_000 + 4_000);
    expect(transport.open).toHaveBeenCalledTimes(4);
    const healthy = transport.last();
    healthy.push(HELLO);
    for (let second = 0; second < 60; second += 15) {
      healthy.push(": ping\n\n");
      await tick(15_000);
    }
    healthy.close();
    await tick(999);
    expect(transport.open).toHaveBeenCalledTimes(4);
    await tick(1);
    expect(transport.open).toHaveBeenCalledTimes(5);

    transport.last().push(HELLO + 'event: reconnect\ndata: {"after_ms":700}\n\n');
    transport.last().close();
    await tick(699);
    expect(transport.open).toHaveBeenCalledTimes(5);
    await tick(1);
    expect(transport.open).toHaveBeenCalledTimes(6);
    manager.stop();
  });

  it("refreshes the token once on 401, then waits for at most 3 recovery signals per 15 min", async () => {
    const { manager, transport, deps } = setup();
    transport.queue.push(status(401), status(401), status(401), status(401), status(401));
    manager.start();
    await tick();
    expect(deps.getToken.mock.calls).toEqual([[false], [true]]);
    expect(manager.phase()).toBe("auth_blocked");
    expect(lastState(deps)).toBe("unavailable");

    // No timer ever retries a blocked stream.
    await tick(10 * 60_000);
    expect(transport.open).toHaveBeenCalledTimes(2);
    manager.focus();
    await tick();
    expect(transport.open).toHaveBeenCalledTimes(2);

    manager.online();
    await tick();
    expect(transport.open).toHaveBeenCalledTimes(3);
    expect(deps.getToken).toHaveBeenLastCalledWith(true);
    // Visible counts only 60 s after the last auth attempt.
    manager.visibility(true);
    await tick();
    expect(transport.open).toHaveBeenCalledTimes(3);
    await tick(60_000);
    manager.visibility(true);
    await tick();
    expect(transport.open).toHaveBeenCalledTimes(4);
    manager.sessionVerification(true);
    manager.sessionVerification(false);
    await tick();
    expect(transport.open).toHaveBeenCalledTimes(5);

    // The fourth signal inside 15 minutes is ignored.
    manager.tokenChanged();
    manager.online();
    await tick();
    expect(transport.open).toHaveBeenCalledTimes(5);
    expect(manager.phase()).toBe("auth_blocked");

    await tick(DOCUMENT_FEED_AUTH_RECOVERY_WINDOW_MS);
    manager.tokenChanged();
    await tick();
    expect(transport.open).toHaveBeenCalledTimes(6);
    transport.last().push(HELLO);
    await tick();
    expect(lastState(deps)).toBe("live");
    manager.stop();
  });

  it("falls back to polling on 503 and never retries before Retry-After", async () => {
    const { manager, transport, deps } = setup();
    transport.queue.push(status(503, 120_000));
    manager.start();
    await tick();
    expect(lastState(deps)).toBe("polling");
    await tick(30_000);
    manager.online();
    manager.focus();
    manager.visibility(true);
    await tick(89_999);
    expect(transport.open).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(transport.open).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it("keeps an absent endpoint unavailable for 30 min", async () => {
    const { manager, transport, deps } = setup();
    transport.queue.push(status(404));
    manager.start();
    await tick(30 * 60_000 - 1);
    expect(transport.open).toHaveBeenCalledTimes(1);
    expect(lastState(deps)).toBe("unavailable");
    await tick(1);
    expect(transport.open).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it("cancels the native attempt in the background and reconnects on resume", async () => {
    const { manager, transport } = setup();
    manager.start();
    await tick();
    transport.last().push(HELLO);
    await tick();
    manager.appActive(false);
    expect(transport.last().signal.aborted).toBe(true);
    await tick(10 * 60_000);
    expect(transport.open).toHaveBeenCalledTimes(1);
    manager.appActive(true);
    await tick();
    expect(transport.open).toHaveBeenCalledTimes(2);
    manager.stop();
  });
});

describe("leader and follower tabs", () => {
  function relayHub() {
    type Member = { onMessage: (message: unknown) => void; promote: () => void; left: boolean };
    const members: Member[] = [];
    const waiting: Member[] = [];
    let holder: Member | null = null;
    return (): FeedStreamCoordinator => {
      let self!: Member;
      return {
        join({ onRole, onMessage }) {
          self = { onMessage, promote: () => onRole("leader"), left: false };
          members.push(self);
          if (holder) {
            onRole("follower");
            waiting.push(self);
          } else {
            holder = self;
            onRole("leader");
          }
        },
        post(message) {
          for (const member of members) {
            if (member === self || member.left) continue;
            const copy = JSON.parse(JSON.stringify(message)) as unknown;
            queueMicrotask(() => member.onMessage(copy));
          }
        },
        leave() {
          self.left = true;
          if (holder !== self) return;
          holder = waiting.shift() ?? null;
          holder?.promote();
        },
      };
    };
  }

  it("relays the leader's frames and state, and a follower takes over when the leader leaves", async () => {
    const coordinator = relayHub();
    const leader = setup({ coordinator: coordinator() });
    const follower = setup({ coordinator: coordinator() });
    leader.manager.start();
    follower.manager.start();
    await tick();
    expect(leader.transport.open).toHaveBeenCalledTimes(1);
    expect(follower.transport.open).not.toHaveBeenCalled();

    leader.transport.last().push(HELLO + RESET + PAYOUT);
    await tick(10_000);
    for (const tab of [leader, follower]) {
      expect(tab.deps.dispatchFeed.mock.calls).toEqual([[FULL], [FULL]]);
      expect(tab.deps.dispatchPayout.mock.calls).toEqual([
        [{ kinds: ALL_KINDS, source: "sse_reset" }],
        [{ kinds: ["wallet"], requestIds: [REQUEST], source: "sse" }],
      ]);
      expect(lastState(tab.deps)).toBe("live");
    }

    leader.manager.stop();
    await tick();
    expect(lastState(follower.deps)).not.toBe("live");
    expect(follower.transport.open).toHaveBeenCalledTimes(1);
    follower.transport.last().push(HELLO);
    await tick();
    expect(lastState(follower.deps)).toBe("live");
    follower.manager.stop();
  });

  it("a hidden leader frees its stream for a visible tab and repairs once on return", async () => {
    const coordinator = relayHub();
    const first = setup({ coordinator: coordinator() });
    const second = setup({ coordinator: coordinator() });
    first.manager.start();
    second.manager.start();
    await tick();
    const hidden = first.transport.last();
    hidden.push(HELLO);
    await tick();

    first.manager.visibility(false);
    await tick();
    expect(hidden.signal.aborted).toBe(true);
    expect(second.transport.open).toHaveBeenCalledTimes(1);
    second.transport.last().push(HELLO);
    await tick(30_000);
    expect(first.transport.open).toHaveBeenCalledTimes(1);
    expect(first.deps.dispatchFeed).not.toHaveBeenCalled();
    expect(lastState(second.deps)).toBe("live");

    // Back in view (iOS may send no focus): it follows the new leader and
    // rereads what it missed, once, however many signals arrive together.
    first.manager.visibility(true);
    await tick();
    expect(first.deps.dispatchFeed).toHaveBeenCalledExactlyOnceWith(FULL);
    first.manager.focus();
    first.manager.online();
    await tick();
    expect(first.transport.open).toHaveBeenCalledTimes(1);
    expect(first.deps.dispatchFeed).toHaveBeenCalledTimes(1);
    second.transport.last().push(RESET);
    await tick();
    expect(lastState(first.deps)).toBe("live");
    first.manager.stop();
    second.manager.stop();
  });

  it("stops claiming live when a live leader goes silent, rereading payouts once", async () => {
    let deliver!: (message: unknown) => void;
    const posts: FeedRelayMessage[] = [];
    const { manager, transport, deps } = setup({
      coordinator: {
        join: ({ onRole, onMessage }) => {
          deliver = onMessage;
          onRole("follower");
        },
        post: (message) => posts.push(message),
        leave: () => {},
      },
    });
    manager.start();
    expect(posts).toEqual([{ v: 1, kind: "sync" }]);
    deliver({ v: 1, kind: "state", state: "live" });
    deliver({ v: 1, kind: "frame", event: "heartbeat", data: '{"ts":1,"live":true}' });
    expect(lastState(deps)).toBe("live");
    // Forged or malformed relay messages are ignored.
    deliver({ v: 1, kind: "frame", event: "payout_changed", data: 7 });
    deliver({ v: 2, kind: "frame", event: "payout_changed", data: "{}" });
    deliver({ v: 1, kind: "frame", event: "hello", data: "{}" });
    await tick(DOCUMENT_FEED_WATCHDOG_MS - 1);
    expect(deps.dispatchPayout).not.toHaveBeenCalled();
    await tick(1);
    expect(lastState(deps)).toBe("reconnecting");
    expect(deps.dispatchPayout).toHaveBeenCalledExactlyOnceWith({ kinds: ALL_KINDS, source: "stall" });
    await tick(5 * 60_000);
    expect(deps.dispatchPayout).toHaveBeenCalledTimes(1);
    deliver({ v: 1, kind: "frame", event: "heartbeat", data: '{"ts":2,"live":true}' });
    expect(lastState(deps)).toBe("live");

    // A follower forwards its lifecycle signals instead of streaming.
    manager.online();
    expect(posts.at(-1)).toEqual({ v: 1, kind: "wake", reason: "online" });
    expect(transport.open).not.toHaveBeenCalled();
    manager.stop();
  });
});

describe("browser coordinator", () => {
  function fakeBrowser(): FeedCoordinatorEnvironment {
    const holders = new Map<string, boolean>();
    const queues = new Map<string, Array<() => void>>();
    const channels = new Map<string, Set<{ deliver: (data: unknown) => void }>>();
    const runHolder = (name: string, callback: () => Promise<void>) => {
      holders.set(name, true);
      return callback().finally(() => {
        holders.set(name, false);
        queues.get(name)?.shift()?.();
      });
    };
    return {
      locks: {
        request(name, { signal }, callback) {
          if (!holders.get(name)) return runHolder(name, callback);
          return new Promise((resolve, reject) => {
            const start = () => runHolder(name, callback).then(resolve, reject);
            queues.set(name, [...(queues.get(name) ?? []), start]);
            signal?.addEventListener("abort", () => {
              queues.set(name, (queues.get(name) ?? []).filter((entry) => entry !== start));
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      },
      openChannel(name) {
        const listeners = new Set<(event: MessageEvent) => void>();
        const self = { deliver: (data: unknown) => listeners.forEach((listener) => listener({ data } as MessageEvent)) };
        const peers = channels.get(name) ?? new Set();
        channels.set(name, peers.add(self));
        const channel: FeedChannel = {
          postMessage: (message) => {
            for (const peer of peers) if (peer !== self) queueMicrotask(() => peer.deliver(message));
          },
          close: () => peers.delete(self),
          addEventListener: (_type, listener) => listeners.add(listener),
          removeEventListener: (_type, listener) => listeners.delete(listener),
        };
        return channel;
      },
    };
  }

  const join = (coordinator: FeedStreamCoordinator) => {
    const roles: FeedStreamRole[] = [];
    const messages: unknown[] = [];
    coordinator.join({ onRole: (role) => roles.push(role), onMessage: (message) => messages.push(message) });
    return { roles, messages };
  };

  it("elects one leader per account with Web Locks and hands over when it leaves", async () => {
    const browser = fakeBrowser();
    const first = createFeedStreamCoordinator("owner", "web", browser);
    const second = createFeedStreamCoordinator("owner", "web", browser);
    const a = join(first);
    const b = join(second);
    await tick();
    expect(a.roles).toEqual(["follower", "leader"]);
    expect(b.roles).toEqual(["follower"]);

    first.post({ v: 1, kind: "state", state: "live" });
    await tick();
    expect(b.messages).toEqual([{ v: 1, kind: "state", state: "live" }]);
    expect(a.messages).toEqual([]);

    first.leave();
    await tick();
    expect(b.roles).toEqual(["follower", "leader"]);
    second.leave();
  });

  it("never acts on an earlier lock request after a tab leaves and joins again", async () => {
    const browser = fakeBrowser();
    const leader = createFeedStreamCoordinator("owner", "web", browser);
    const returning = createFeedStreamCoordinator("owner", "web", browser);
    join(leader);
    const roles: FeedStreamRole[] = [];
    const messages: unknown[] = [];
    const handlers = { onRole: (role: FeedStreamRole) => roles.push(role), onMessage: (m: unknown) => messages.push(m) };
    returning.join(handlers);
    // Hidden, then visible again while its first request is still queued.
    returning.leave();
    returning.join(handlers);
    await tick();
    expect(roles).toEqual(["follower", "follower"]);
    leader.post({ v: 1, kind: "sync" });
    await tick();
    expect(messages).toEqual([{ v: 1, kind: "sync" }]);
    leader.leave();
    await tick();
    expect(roles).toEqual(["follower", "follower", "leader"]);
    returning.leave();
  });

  it("lets every tab stream alone, relaying nothing, without Web Locks", () => {
    const openChannel = vi.fn();
    const coordinator = createFeedStreamCoordinator("owner", "web", { locks: null, openChannel });
    expect(join(coordinator).roles).toEqual(["leader"]);
    coordinator.post({ v: 1, kind: "sync" });
    expect(openChannel).not.toHaveBeenCalled();
    expect(join(createFeedStreamCoordinator("owner", "native", fakeBrowser())).roles).toEqual(["leader"]);
  });
});

describe("transports", () => {
  it("streams on web from the backend origin, and a 401 never signs anyone out", async () => {
    const fetchMock = vi.fn(async () => new Response('{"detail":"Invalid Firebase ID token"}', { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const invalidated = vi.fn();
    window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, invalidated);
    const { manager } = setup({ transport: createDocumentFeedTransport("web") });
    manager.start();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe("https://backend.test/api/one/feed/events?v=2");
    expect(calls[0]![1]).toMatchObject({
      method: "GET",
      credentials: "omit",
      headers: { Authorization: "Bearer token", Accept: "text/event-stream" },
    });
    expect((calls[1]![1].headers as Record<string, string>).Authorization).toBe("Bearer fresh-token");
    expect(manager.phase()).toBe("auth_blocked");
    expect(invalidated).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, invalidated);
    manager.stop();
  });

  it.each([
    ["the browser blocks the direct origin", () => Promise.reject(new TypeError("Failed to fetch")), 5 * 60_000],
    ["the direct stream is disabled", async () => new Response("{}", { status: 404 }), 30 * 60_000],
    ["the backend is busy", async () => new Response("{}", { status: 503, headers: { "Retry-After": "120" } }), 120_000],
  ])("falls back to the same-origin proxy when %s, and skips the direct route for a while", async (_case, direct, skipMs) => {
    const proxied = () => new Response("event: feed_reset\ndata: {}\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
    const fetchMock = vi.fn(async (url: string) => (url.startsWith("https://backend.test/") ? direct() : proxied()));
    vi.stubGlobal("fetch", fetchMock);
    let now = 0;
    const transport = createDocumentFeedTransport("web", () => now);
    const open = () => transport.open({ uid: "owner/1", token: "token", signal: new AbortController().signal });

    const first = await open();
    expect(first.status).toBe(200);
    const urls = () => (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map(([url]) => url);
    expect(urls()).toEqual([
      "https://backend.test/api/one/feed/events?v=2",
      "/api/consent/document-feed/owner%2F1?v=2",
    ]);
    const proxyInit = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[1]![1];
    expect(proxyInit).toMatchObject({ headers: { Authorization: "Bearer token", Accept: "text/event-stream" } });

    now = skipMs - 1;
    await open();
    expect(urls().filter((url) => url.startsWith("https://"))).toHaveLength(1);
    now = skipMs;
    await open();
    expect(urls().filter((url) => url.startsWith("https://"))).toHaveLength(2);
  });

  it("does not fall back when the attempt itself was cancelled", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
      return new Response(null);
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = createDocumentFeedTransport("web").open({ uid: "owner", token: "token", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("streams on native through the cancellable plugin with typed frames requested", async () => {
    transportMocks.nativeStreamFetch.mockResolvedValue(new Response("", { status: 503, headers: { "Retry-After": "90" } }));
    const result = await createDocumentFeedTransport("native").open({
      uid: "user/1",
      token: "token",
      signal: new AbortController().signal,
    });
    expect(transportMocks.nativeStreamFetch).toHaveBeenCalledExactlyOnceWith(
      "/api/consent/document-feed/user%2F1?v=2",
      expect.objectContaining({ headers: { Authorization: "Bearer token", Accept: "text/event-stream" } }),
    );
    expect(result).toEqual({ status: 503, body: null, retryAfterMs: 90_000 });
  });
});
