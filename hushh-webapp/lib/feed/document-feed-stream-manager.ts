/**
 * Document-feed stream manager: one connection state machine per account.
 *
 * Framework-free. It owns no network code and no DOM listeners: a transport
 * opens one attempt, a coordinator says whether this tab streams (leader) or
 * receives the leader's frames (follower), and the caller forwards lifecycle
 * signals (online, focus, visibility, native app state, auth). Frames are
 * reread hints, never authority.
 *
 * Contract (docs/reference/streaming/streaming-implementation-guide.md):
 * - per-attempt AbortController; a 45 s watchdog on bytes (comments count)
 *   aborts a silent attempt, invalidates payout data once and reconnects;
 * - backoff 1/2/4/8/16/30 s with +/-20% jitter, reset after 60 s healthy;
 *   8 failures switch to polling (retry on online, visible, focus, or 5 min);
 * - a 503 waits for Retry-After (60 s default) and polls meanwhile;
 * - 401: one refresh retry, then auth_blocked until a recovery signal, at most
 *   3 recovery attempts per 15 min. A stream 401 never signs anyone out;
 * - payout_changed only rings the payout bus; feed frames keep the Feed's
 *   CONSENT_STATE_CHANGED (one emit per burst, a trailing one only when more
 *   frames arrived); feed_reset also rereads every payout kind.
 */
import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { PAYOUT_KINDS, type PayoutChangeSource } from "@/lib/payouts/payout-events";
import type { PayoutStreamState } from "@/lib/payouts/payout-live-store";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";

export const DOCUMENT_FEED_WATCHDOG_MS = 45_000;
export const DOCUMENT_FEED_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
export const DOCUMENT_FEED_MAX_FAILURES = 8;
export const DOCUMENT_FEED_POLLING_RETRY_MS = 5 * 60_000;
export const DOCUMENT_FEED_AUTH_RECOVERY_LIMIT = 3;
export const DOCUMENT_FEED_AUTH_RECOVERY_WINDOW_MS = 15 * 60_000;
const BACKOFF_JITTER = 0.2;
const HEALTHY_RESET_MS = 60_000;
const SIGNAL_RETRY_GAP_MS = 10_000;
const UNAVAILABLE_RETRY_MS = 30 * 60_000;
const BUSY_RETRY_MS = 60_000;
const AUTH_VISIBLE_RECOVERY_GAP_MS = 60_000;
const STALE_ON_VISIBLE_MS = 20_000;
const MAX_FRAME_REMAINDER = 16_384;
const MAX_RECONNECT_AFTER_MS = 2_000;
// A burst's trailing reread waits for this much quiet, but never longer than
// the cap after its first frame, so a continuous stream still rereads.
const REFRESH_SETTLE_MS = 1_000;
const REFRESH_MAX_WAIT_MS = 5_000;

export type DocumentFeedOpenResult = {
  status: number;
  body: ReadableStream<Uint8Array> | null;
  /** From Retry-After, when the response exposes it. */
  retryAfterMs: number | null;
};

export type DocumentFeedTransport = {
  open(request: { uid: string; token: string; signal: AbortSignal }): Promise<DocumentFeedOpenResult>;
};

export type FeedStreamRole = "leader" | "follower";

const RELAYED_EVENTS = ["feed_reset", "feed_changed", "payout_changed", "heartbeat"] as const;
const WAKE_REASONS = ["online", "visible", "focus"] as const;
const STREAM_STATES = ["live", "reconnecting", "polling", "unavailable"] as const;
type RelayedEvent = (typeof RELAYED_EVENTS)[number];
type WakeReason = (typeof WAKE_REASONS)[number];

/** Messages between the leader tab and followers (same origin, same account). */
export type FeedRelayMessage =
  | { v: 1; kind: "frame"; event: RelayedEvent; data: string }
  | { v: 1; kind: "state"; state: PayoutStreamState }
  | { v: 1; kind: "sync" }
  | { v: 1; kind: "wake"; reason: WakeReason };

export type FeedStreamCoordinator = {
  /** Reports "leader" at once, or "follower" first and "leader" when this tab takes over. */
  join(handlers: { onRole: (role: FeedStreamRole) => void; onMessage: (message: unknown) => void }): void;
  post(message: FeedRelayMessage): void;
  leave(): void;
};

export type DocumentFeedStreamPhase =
  | "idle"
  | "following"
  | "connecting"
  | "open"
  | "live"
  | "degraded"
  | "backoff"
  | "polling"
  | "paused"
  | "auth_blocked"
  | "unavailable";

export type DocumentFeedStreamDeps = {
  uid: string;
  transport: DocumentFeedTransport;
  coordinator: FeedStreamCoordinator;
  getToken: (forceRefresh: boolean) => Promise<string>;
  /** Feed reread (CONSENT_STATE_CHANGED); requestId narrows it to one request. */
  dispatchFeed: (detail: { requestId?: string }) => void;
  /** Payout bus only; never the consent cache cascade. */
  dispatchPayout: (detail: { kinds: unknown; requestIds?: unknown; source: PayoutChangeSource }) => void;
  onStreamState: (state: PayoutStreamState) => void;
  onPhase?: (phase: DocumentFeedStreamPhase) => void;
  now?: () => number;
  random?: () => number;
};

export type DocumentFeedStreamManager = {
  start(): void;
  stop(): void;
  online(): void;
  focus(): void;
  visibility(visible: boolean): void;
  /** Native app state: background cancels the attempt to free its server slot. */
  appActive(active: boolean): void;
  /** A new ID token was issued for this account (web). */
  tokenChanged(): void;
  sessionVerification(required: boolean): void;
  phase(): DocumentFeedStreamPhase;
};

type Attempt = {
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  connectedAt: number | null;
  stalled: boolean;
  recovering: boolean;
};

type Outcome =
  | { kind: "status"; status: number; retryAfterMs: number | null }
  | { kind: "closed"; reconnectAfterMs: number | null }
  | { kind: "failed" };

type Timer = ReturnType<typeof setTimeout>;

const ALL_PAYOUT_KINDS = (): string[] => [...PAYOUT_KINDS];

function streamStateFor(phase: DocumentFeedStreamPhase): PayoutStreamState {
  switch (phase) {
    case "live":
      return "live";
    case "idle":
    case "polling":
      return "polling";
    case "auth_blocked":
    case "unavailable":
      return "unavailable";
    default:
      return "reconnecting";
  }
}

function readObject(data: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readLive(data: string): boolean | undefined {
  const live = readObject(data)?.live;
  return typeof live === "boolean" ? live : undefined;
}

function readRequestId(data: string): string | null {
  const requestId = readObject(data)?.request_id;
  return typeof requestId === "string" && DOCUMENT_REQUEST_UUID.test(requestId) ? requestId : null;
}

function readReconnectAfter(data: string): number {
  const after = readObject(data)?.after_ms;
  if (typeof after !== "number" || !Number.isFinite(after)) return MAX_RECONNECT_AFTER_MS / 2;
  return Math.min(Math.max(Math.round(after), 0), MAX_RECONNECT_AFTER_MS);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** Strict shape check for a message from another tab. */
export function parseFeedRelayMessage(raw: unknown): FeedRelayMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as Record<string, unknown>;
  if (message.v !== 1) return null;
  switch (message.kind) {
    case "frame":
      return isOneOf(RELAYED_EVENTS, message.event) &&
        typeof message.data === "string" &&
        message.data.length <= MAX_FRAME_REMAINDER
        ? { v: 1, kind: "frame", event: message.event, data: message.data }
        : null;
    case "state":
      return isOneOf(STREAM_STATES, message.state) ? { v: 1, kind: "state", state: message.state } : null;
    case "sync":
      return { v: 1, kind: "sync" };
    case "wake":
      return isOneOf(WAKE_REASONS, message.reason) ? { v: 1, kind: "wake", reason: message.reason } : null;
    default:
      return null;
  }
}

class DocumentFeedStreamMachine implements DocumentFeedStreamManager {
  private readonly deps: DocumentFeedStreamDeps;
  private readonly now: () => number;
  private readonly random: () => number;
  private running = false;
  private role: FeedStreamRole | null = null;
  private current: DocumentFeedStreamPhase = "idle";
  private reported: PayoutStreamState | null = null;
  private attempt: Attempt | null = null;
  private failures = 0;
  private retryTimer: Timer | null = null;
  private retryAt: number | null = null;
  private watchdogTimer: Timer | null = null;
  private notBefore = 0;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private lastByteAt = 0;
  private stallReported = false;
  private permanentlyUnavailable = false;
  private paused = false;
  private authRetryUsed = false;
  private refreshNextToken = false;
  private recoverNext = false;
  private lastAuthAttemptAt = Number.NEGATIVE_INFINITY;
  private recoveries: number[] = [];
  private sessionRequired: boolean | null = null;
  private leaderState: PayoutStreamState = "reconnecting";
  private leaderSilent = false;
  private followerTimer: Timer | null = null;
  private settleTimer: Timer | null = null;
  private burstStartedAt = 0;
  private burstRequestId: string | undefined;
  private burstHasMore = false;
  private burstReset = false;

  constructor(deps: DocumentFeedStreamDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? (() => Math.random());
  }

  phase(): DocumentFeedStreamPhase {
    return this.current;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.deps.coordinator.join({
      onRole: (role) => this.onRole(role),
      onMessage: (message) => this.onMessage(message),
    });
  }

  stop(): void {
    if (!this.running) return;
    // Followers keep polling instead of waiting out a silence watchdog.
    if (this.role === "leader") this.post({ v: 1, kind: "state", state: "reconnecting" });
    this.running = false;
    this.clearRetry();
    this.clearWatchdog();
    this.clearFollowerTimer();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.abandonAttempt();
    this.deps.coordinator.leave();
    this.role = null;
    this.setPhase("idle");
  }

  online(): void {
    this.wake("online");
  }

  focus(): void {
    this.wake("focus");
  }

  visibility(visible: boolean): void {
    if (visible) this.wake("visible");
  }

  appActive(active: boolean): void {
    if (active) this.resume();
    else this.pause();
  }

  tokenChanged(): void {
    if (this.running && this.role === "leader" && !this.paused && this.current === "auth_blocked") {
      this.tryAuthRecovery();
    }
  }

  sessionVerification(required: boolean): void {
    const previous = this.sessionRequired;
    this.sessionRequired = required;
    if (previous === true && !required) this.tokenChanged();
  }

  // --- roles and relay -------------------------------------------------------

  private onRole(role: FeedStreamRole): void {
    if (!this.running || this.role === "leader" || this.role === role) return;
    this.role = role;
    if (role === "follower") {
      this.leaderState = "reconnecting";
      this.setPhase("following");
      this.post({ v: 1, kind: "sync" });
      return;
    }
    this.clearFollowerTimer();
    this.leaderSilent = false;
    // Announce the new leader's state even if this tab already showed it.
    this.reported = null;
    this.connectNow();
  }

  private onMessage(raw: unknown): void {
    if (!this.running) return;
    const message = parseFeedRelayMessage(raw);
    if (!message) return;
    if (this.role === "leader") {
      if (message.kind === "sync") {
        this.post({ v: 1, kind: "state", state: this.reported ?? streamStateFor(this.current) });
      } else if (message.kind === "wake") {
        this.wake(message.reason);
      }
      return;
    }
    if (this.role !== "follower") return;
    if (message.kind === "state") this.leaderState = message.state;
    else if (message.kind === "frame") this.applyFrame(message.event, message.data, false);
    else return;
    this.heardLeader();
  }

  private heardLeader(): void {
    this.clearFollowerTimer();
    if (this.leaderSilent) this.stallReported = false;
    this.leaderSilent = false;
    if (this.leaderState === "live") {
      this.followerTimer = setTimeout(() => {
        this.followerTimer = null;
        this.leaderSilent = true;
        this.reportStall();
        this.publish();
      }, DOCUMENT_FEED_WATCHDOG_MS);
    }
    this.publish();
  }

  private post(message: FeedRelayMessage): void {
    this.deps.coordinator.post(message);
  }

  // --- connection ------------------------------------------------------------

  private connectNow(): void {
    const wait = this.notBefore - this.now();
    if (wait > 0) {
      this.schedule(wait, this.current === "following" ? "backoff" : this.current);
      return;
    }
    this.clearRetry();
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.running || this.role !== "leader" || this.paused || this.attempt) return;
    const attempt: Attempt = {
      controller: new AbortController(),
      reader: null,
      connectedAt: null,
      stalled: false,
      recovering: this.recoverNext,
    };
    const refresh = this.refreshNextToken || attempt.recovering;
    this.recoverNext = false;
    this.refreshNextToken = false;
    this.attempt = attempt;
    this.lastAttemptAt = this.now();
    if (refresh) this.lastAuthAttemptAt = this.lastAttemptAt;
    this.setPhase("connecting");
    this.armWatchdog(attempt);
    let outcome: Outcome;
    try {
      const token = await this.deps.getToken(refresh);
      if (this.attempt !== attempt) return;
      const result = await this.deps.transport.open({
        uid: this.deps.uid,
        token,
        signal: attempt.controller.signal,
      });
      if (this.attempt !== attempt) {
        if (result.body) void result.body.cancel().catch(() => undefined);
        return;
      }
      outcome = await this.consume(attempt, result);
    } catch {
      outcome = { kind: "failed" };
    }
    if (this.attempt !== attempt) return;
    this.attempt = null;
    this.clearWatchdog();
    this.settle(attempt, outcome);
  }

  private async consume(attempt: Attempt, result: DocumentFeedOpenResult): Promise<Outcome> {
    const body = result.body;
    if (result.status < 200 || result.status >= 300 || !body) {
      if (body) void body.cancel().catch(() => undefined);
      return { kind: "status", status: result.status, retryAfterMs: result.retryAfterMs };
    }
    attempt.connectedAt = this.now();
    this.lastByteAt = attempt.connectedAt;
    let lastFrameAt = attempt.connectedAt;
    this.authRetryUsed = false;
    this.armWatchdog(attempt);
    this.setPhase("open");
    const reader = body.getReader();
    attempt.reader = reader;
    const decoder = new TextDecoder();
    let remainder = "";
    let reconnectAfterMs: number | null = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.attempt !== attempt) break;
        if (!value || value.byteLength === 0) continue;
        this.lastByteAt = this.now();
        this.armWatchdog(attempt);
        const parsed = parseSSEBlocks(decoder.decode(value, { stream: true }), remainder);
        remainder = parsed.remainder;
        if (remainder.length > MAX_FRAME_REMAINDER) return { kind: "failed" };
        if (parsed.events.length) lastFrameAt = this.lastByteAt;
        for (const frame of parsed.events) {
          if (this.attempt !== attempt) break;
          const after = this.applyFrame(frame.event, frame.data, true);
          if (after !== null) reconnectAfterMs = after;
        }
        // Pings alone keep the connection, not "live": that needs v2 frames.
        if (this.current === "live" && this.lastByteAt - lastFrameAt > DOCUMENT_FEED_WATCHDOG_MS) {
          this.setPhase("degraded");
        }
      }
    } finally {
      attempt.reader = null;
      void reader.cancel().catch(() => undefined);
    }
    return { kind: "closed", reconnectAfterMs };
  }

  private settle(attempt: Attempt, outcome: Outcome): void {
    if (attempt.connectedAt !== null && this.now() - attempt.connectedAt >= HEALTHY_RESET_MS) {
      this.failures = 0;
    }
    if (attempt.stalled) {
      if (attempt.connectedAt !== null) this.reportStall();
      this.fail(0);
      return;
    }
    if (outcome.kind === "status") {
      this.settleStatus(attempt, outcome.status, outcome.retryAfterMs);
      return;
    }
    if (outcome.kind === "closed" && outcome.reconnectAfterMs !== null) {
      // The server rotated the stream on purpose; that is not a failure.
      this.schedule(outcome.reconnectAfterMs, "backoff");
      return;
    }
    this.fail(null);
  }

  private settleStatus(attempt: Attempt, status: number, retryAfterMs: number | null): void {
    if (status === 401) {
      if (!attempt.recovering && !this.authRetryUsed) {
        this.authRetryUsed = true;
        this.refreshNextToken = true;
        this.schedule(0, "connecting");
        return;
      }
      this.block("auth_blocked");
      return;
    }
    if (status === 403) {
      // The token belongs to another account; a new account gets a new manager.
      this.permanentlyUnavailable = true;
      this.block("unavailable");
      return;
    }
    if (status === 400 || status === 404 || status === 410) {
      this.schedule(UNAVAILABLE_RETRY_MS, "unavailable");
      return;
    }
    if (status === 503) {
      this.failures += 1;
      const wait = Math.max(retryAfterMs ?? 0, BUSY_RETRY_MS);
      this.notBefore = this.now() + wait;
      this.schedule(
        this.failures >= DOCUMENT_FEED_MAX_FAILURES ? Math.max(wait, DOCUMENT_FEED_POLLING_RETRY_MS) : wait,
        "polling",
      );
      return;
    }
    this.fail(null);
  }

  private fail(delayMs: number | null): void {
    this.failures += 1;
    if (this.failures >= DOCUMENT_FEED_MAX_FAILURES) {
      this.schedule(DOCUMENT_FEED_POLLING_RETRY_MS, "polling");
      return;
    }
    this.schedule(delayMs ?? this.backoffDelay(), "backoff");
  }

  private backoffDelay(): number {
    const steps = DOCUMENT_FEED_BACKOFF_MS;
    const base = steps[Math.min(this.failures, steps.length) - 1] ?? steps[steps.length - 1] ?? 30_000;
    return Math.round(base * (1 + (this.random() * 2 - 1) * BACKOFF_JITTER));
  }

  private schedule(delayMs: number, phase: DocumentFeedStreamPhase): void {
    this.clearRetry();
    const wait = Math.max(0, delayMs, this.notBefore - this.now());
    this.retryAt = this.now() + wait;
    this.setPhase(phase);
    if (this.paused) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = null;
      void this.connect();
    }, wait);
  }

  private block(phase: "auth_blocked" | "unavailable"): void {
    this.clearRetry();
    this.setPhase(phase);
  }

  private reportStall(): void {
    if (this.stallReported) return;
    this.stallReported = true;
    this.deps.dispatchPayout({ kinds: ALL_PAYOUT_KINDS(), source: "stall" });
  }

  private abortAttempt(stalled: boolean): void {
    const attempt = this.attempt;
    if (!attempt) return;
    attempt.stalled = stalled;
    attempt.controller.abort();
    if (attempt.reader) void attempt.reader.cancel().catch(() => undefined);
  }

  private abandonAttempt(): void {
    const attempt = this.attempt;
    this.attempt = null;
    this.clearWatchdog();
    if (!attempt) return;
    attempt.controller.abort();
    if (attempt.reader) void attempt.reader.cancel().catch(() => undefined);
  }

  private armWatchdog(attempt: Attempt): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.attempt === attempt) this.abortAttempt(true);
    }, DOCUMENT_FEED_WATCHDOG_MS);
  }

  // --- lifecycle signals -----------------------------------------------------

  private wake(reason: WakeReason): void {
    if (!this.running) return;
    if (this.role === "follower") {
      // Only the leader streams; let it react to this tab's signal.
      this.post({ v: 1, kind: "wake", reason });
      return;
    }
    if (this.role !== "leader" || this.paused) return;
    const now = this.now();
    switch (this.current) {
      case "auth_blocked":
        if (
          reason === "online" ||
          (reason === "visible" && now - this.lastAuthAttemptAt >= AUTH_VISIBLE_RECOVERY_GAP_MS)
        ) {
          this.tryAuthRecovery();
        }
        return;
      case "polling":
        this.retryEarly(reason !== "online");
        return;
      case "backoff":
        if (reason === "online") this.retryEarly(false);
        return;
      case "open":
      case "live":
      case "degraded":
        if (reason === "visible" && now - this.lastByteAt > STALE_ON_VISIBLE_MS) this.abortAttempt(true);
        return;
      default:
        return;
    }
  }

  private retryEarly(respectGap: boolean): void {
    const now = this.now();
    if (now < this.notBefore) return;
    if (respectGap && now - this.lastAttemptAt < SIGNAL_RETRY_GAP_MS) return;
    this.connectNow();
  }

  private tryAuthRecovery(): void {
    if (this.attempt || this.current !== "auth_blocked") return;
    const now = this.now();
    this.recoveries = this.recoveries.filter(
      (at) => now - at < DOCUMENT_FEED_AUTH_RECOVERY_WINDOW_MS,
    );
    if (this.recoveries.length >= DOCUMENT_FEED_AUTH_RECOVERY_LIMIT) return;
    this.recoveries.push(now);
    this.recoverNext = true;
    this.connectNow();
  }

  private pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.role !== "leader") return;
    const hadAttempt = this.attempt !== null;
    this.abandonAttempt();
    if (hadAttempt || this.current === "backoff") this.setPhase("paused");
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (!this.running || this.role !== "leader") return;
    const now = this.now();
    switch (this.current) {
      case "auth_blocked":
        if (now - this.lastAuthAttemptAt >= AUTH_VISIBLE_RECOVERY_GAP_MS) this.tryAuthRecovery();
        return;
      case "unavailable":
        if (!this.permanentlyUnavailable) this.schedule(Math.max(0, (this.retryAt ?? now) - now), "unavailable");
        return;
      case "polling":
        if (now >= this.notBefore && now - this.lastAttemptAt >= SIGNAL_RETRY_GAP_MS) this.connectNow();
        else this.schedule(Math.max(0, (this.retryAt ?? now) - now), "polling");
        return;
      default:
        this.connectNow();
    }
  }

  // --- frames ----------------------------------------------------------------

  /** Returns a reconnect delay when the frame announces the server's close. */
  private applyFrame(event: string, data: string, fromStream: boolean): number | null {
    switch (event) {
      case "hello":
        if (fromStream) {
          this.stallReported = false;
          this.setPhase(readLive(data) === false ? "degraded" : "live");
        }
        return null;
      case "heartbeat":
        if (fromStream) {
          this.relay("heartbeat", data);
          // Only a v2 stream (hello received) reports server health.
          if (this.current === "live" || this.current === "degraded") {
            this.setPhase(readLive(data) === false ? "degraded" : "live");
          }
        }
        return null;
      case "feed_reset":
        if (fromStream) this.relay("feed_reset", data);
        this.feedBurst({ reset: true });
        return null;
      case "feed_changed": {
        const requestId = readRequestId(data);
        if (!requestId) return null;
        if (fromStream) this.relay("feed_changed", data);
        this.feedBurst({ requestId });
        return null;
      }
      case "payout_changed": {
        if (fromStream) this.relay("payout_changed", data);
        const payload = readObject(data);
        this.deps.dispatchPayout({
          kinds: payload?.kinds,
          requestIds: payload?.request_ids,
          source: "sse",
        });
        return null;
      }
      case "reconnect":
        return fromStream ? readReconnectAfter(data) : null;
      default:
        return null;
    }
  }

  private relay(event: RelayedEvent, data: string): void {
    if (this.role === "leader") this.post({ v: 1, kind: "frame", event, data });
  }

  // Every surface rereads on a burst's first frame. A forced reread joins any
  // read already in flight, which may predate later frames, so a burst that
  // grew gets exactly one trailing reread. Request ids that differ within a
  // burst widen that reread to the whole account.
  private feedBurst(change: { reset?: boolean; requestId?: string }): void {
    if (change.reset) this.burstReset = true;
    const now = this.now();
    if (this.settleTimer === null) {
      this.burstStartedAt = now;
      this.burstRequestId = change.requestId;
      this.burstHasMore = false;
      this.emitFeed(change.requestId);
    } else {
      clearTimeout(this.settleTimer);
      this.burstHasMore = true;
      if (this.burstRequestId !== change.requestId) this.burstRequestId = undefined;
    }
    this.settleTimer = setTimeout(
      () => {
        this.settleTimer = null;
        if (this.running && this.burstHasMore) this.emitFeed(this.burstRequestId);
      },
      Math.max(0, Math.min(REFRESH_SETTLE_MS, this.burstStartedAt + REFRESH_MAX_WAIT_MS - now)),
    );
  }

  private emitFeed(requestId: string | undefined): void {
    this.deps.dispatchFeed(requestId ? { requestId } : {});
    if (!this.burstReset) return;
    this.burstReset = false;
    this.deps.dispatchPayout({ kinds: ALL_PAYOUT_KINDS(), source: "sse_reset" });
  }

  // --- state -----------------------------------------------------------------

  private setPhase(phase: DocumentFeedStreamPhase): void {
    if (this.current !== phase) {
      this.current = phase;
      this.deps.onPhase?.(phase);
    }
    this.publish();
  }

  private publish(): void {
    const state =
      this.role === "follower"
        ? this.leaderSilent
          ? "reconnecting"
          : this.leaderState
        : streamStateFor(this.current);
    if (state === this.reported) return;
    this.reported = state;
    this.deps.onStreamState(state);
    if (this.role === "leader") this.post({ v: 1, kind: "state", state });
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private clearFollowerTimer(): void {
    if (this.followerTimer) clearTimeout(this.followerTimer);
    this.followerTimer = null;
  }
}

export function createDocumentFeedStreamManager(deps: DocumentFeedStreamDeps): DocumentFeedStreamManager {
  return new DocumentFeedStreamMachine(deps);
}
