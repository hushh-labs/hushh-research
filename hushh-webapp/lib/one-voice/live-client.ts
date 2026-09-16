/**
 * OneLiveClient: the app side of the `one-voice-v1` socket.
 *
 * One socket, one session. The client mints a ticket, opens
 * `${backend}/api/one/voice/live?ticket=`, sends the `auth` frame FIRST, and
 * resolves `connect()` on `session.ready`. It never reconnects on its own;
 * it reports close codes and the provider decides. It never talks to a
 * provider host directly and never falls back to `window.location.origin`
 * (the Next proxy is HTTP-only).
 *
 * Audio discipline (ported from the retired Gemini client):
 * - nothing is sent before `session.ready`; frames captured meanwhile sit in
 *   a bounded onset buffer (<= 1.5 s) that is flushed once, in order;
 * - a real-time pacing guard drops a frame that arrives less than a quarter
 *   of a frame interval after the previous send (a stalled main thread
 *   draining its backlog, never live speech);
 * - a socket backlog above 256 KB drops audio only and marks the session
 *   degraded; control frames (confirm, cancel, steps) always go through.
 */

import {
  INPUT_MIME,
  ONE_VOICE_PROTOCOL_VERSION,
  parseServerFrame,
  type AppContextFrame,
  type ClientFrame,
  type ServerFrame,
} from "@/lib/one-voice/protocol";
import {
  base64FromBytes,
  INPUT_SAMPLE_RATE,
  pcm16DurationMs,
} from "@/lib/one-voice/audio/pcm";
import {
  VoiceUnavailableError,
  type VoiceClientKind,
} from "@/lib/one-voice/ticket";
import { resolveRuntimeBackendUrl } from "@/lib/runtime/settings";
import { normalizeNativeBackendUrl } from "@/lib/services/api-service";

/** The subset of WebSocket the client uses; tests pass a fake. */
export interface LiveSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type LiveSocketConstructor = new (url: string) => LiveSocket;

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

export type LiveCloseInfo = {
  code: number;
  reason: string;
  clean: boolean;
  /** Whether a fresh connect could reasonably succeed (the provider decides). */
  resumable: boolean;
};

export type LiveClientAuth = {
  vaultOwnerToken: string;
  firebaseIdToken?: string | null;
  conversationId: string;
  client: VoiceClientKind;
};

export type LiveClientStats = {
  droppedBacklogFrames: number;
  droppedPacingFrames: number;
  bufferedAmount: number;
  degraded: boolean;
  seq: number;
  onsetBufferedFrames: number;
  onsetFlushedFrames: number;
};

export type OneLiveClientOptions = {
  ticket: () => Promise<{ ticket: string; wsPath: string }>;
  auth: () => LiveClientAuth | null;
  onFrame: (frame: ServerFrame) => void;
  onClose: (info: LiveCloseInfo) => void;
  onDegraded?: (degraded: boolean) => void;
  /** Resume the conversation's Live context instead of starting fresh. */
  resume?: boolean;
  WebSocketImpl?: LiveSocketConstructor;
  now?: () => number;
  connectTimeoutMs?: number;
};

export type LiveClientPhase =
  "idle" | "connecting" | "open" | "ready" | "closed";

export type AppContextInput = Omit<AppContextFrame, "type">;

export const ONSET_BUFFER_MAX_MS = 1500;
export const PACING_GUARD_FRACTION = 0.25;
export const BACKLOG_DROP_BYTES = 256 * 1024;
const BACKLOG_RECOVER_BYTES = BACKLOG_DROP_BYTES / 2;
export const PING_INTERVAL_MS = 20_000;
export const APP_CONTEXT_COALESCE_MS = 150;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

const NON_RESUMABLE_CLOSE_CODES = new Set<number>([
  1000, 4001, 4003, 4008, 4030,
]);

const CLOSE_CODE_LABELS: Record<number, string> = {
  1000: "ended",
  1001: "going_away",
  1006: "abnormal",
  1011: "server_error",
  4001: "disabled",
  4003: "auth",
  4004: "ticket",
  4008: "protocol",
  4009: "idle",
  4010: "max_duration",
  4013: "provider_unavailable",
  4029: "capacity",
  4030: "replaced",
};

export function describeCloseCode(code: number, reason?: string): string {
  const trimmed = String(reason || "").trim();
  if (trimmed) return trimmed;
  return CLOSE_CODE_LABELS[code] ?? `close_${code}`;
}

export function isResumableCloseCode(code: number): boolean {
  return !NON_RESUMABLE_CLOSE_CODES.has(code);
}

function defaultNow(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * The socket base: the configured backend origin with `http(s)` rewritten to
 * `ws(s)`, after the same native loopback rewrite the HTTP layer applies.
 * Empty means the app has no backend origin, which is a hard error; the
 * page origin is never a fallback because the Next proxy cannot upgrade.
 */
export function resolveVoiceSocketBase(): string {
  const backend = resolveRuntimeBackendUrl();
  if (!backend) return "";
  const normalized = normalizeNativeBackendUrl(backend);
  if (!/^https?:\/\//i.test(normalized)) return "";
  return normalized.replace(/^http/i, "ws");
}

function errorFrameReason(code: string): VoiceUnavailableError["reason"] {
  switch (code) {
    case "ONE_VOICE_LIVE_DISABLED":
      return "disabled";
    case "ONE_VOICE_NOT_CONFIGURED":
      return "not_configured";
    case "capacity":
      return "capacity";
    case "auth_required":
    case "auth_mismatch":
    case "auth_invalid":
      return "unauthorized";
    default:
      return "unknown";
  }
}

export class OneLiveClient {
  private readonly options: OneLiveClientOptions;
  private readonly now: () => number;
  private readonly WebSocketImpl: LiveSocketConstructor | null;

  private ws: LiveSocket | null = null;
  private phase: LiveClientPhase = "idle";
  private sessionIdValue: string | null = null;
  private connectPromise: Promise<void> | null = null;
  private closeReported = false;
  /** Rejects a connect() that is still pending when the socket goes away. */
  private rejectConnect: ((error: unknown) => void) | null = null;
  private localCloseReason: string | null = null;

  private seq = 0;
  private lastPacedSendAt: number | null = null;
  private onsetBuffer: Uint8Array[] = [];
  private onsetBufferBytes = 0;
  private onsetFlushed = false;
  private onsetFlushedFrames = 0;
  private droppedBacklogFrames = 0;
  private droppedPacingFrames = 0;
  private degraded = false;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private appContextTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAppContext: AppContextInput | null = null;

  constructor(options: OneLiveClientOptions) {
    this.options = options;
    this.now = options.now ?? defaultNow;
    this.WebSocketImpl =
      options.WebSocketImpl ??
      (typeof WebSocket !== "undefined"
        ? (WebSocket as unknown as LiveSocketConstructor)
        : null);
  }

  // -- state ---------------------------------------------------------------

  get state(): LiveClientPhase {
    return this.phase;
  }

  get isReady(): boolean {
    return (
      this.phase === "ready" &&
      this.ws !== null &&
      this.ws.readyState === SOCKET_OPEN
    );
  }

  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  stats(): LiveClientStats {
    return {
      droppedBacklogFrames: this.droppedBacklogFrames,
      droppedPacingFrames: this.droppedPacingFrames,
      bufferedAmount: this.ws?.bufferedAmount ?? 0,
      degraded: this.degraded,
      seq: this.seq,
      onsetBufferedFrames: this.onsetBuffer.length,
      onsetFlushedFrames: this.onsetFlushedFrames,
    };
  }

  // -- lifecycle -----------------------------------------------------------

  /**
   * Mint a ticket, open the socket, send `auth` first, resolve on
   * `session.ready`. Rejects with `VoiceUnavailableError` on an error frame,
   * a close before ready, a missing backend origin, or a timeout.
   */
  connect(): Promise<void> {
    if (this.phase === "closed") {
      return Promise.reject(
        new VoiceUnavailableError("closed", {
          message: "This voice client was already used.",
        }),
      );
    }
    if (this.connectPromise) return this.connectPromise;
    this.phase = "connecting";
    this.connectPromise = this.open();
    return this.connectPromise;
  }

  private async open(): Promise<void> {
    const auth = this.options.auth();
    if (!auth || !auth.vaultOwnerToken || !auth.conversationId) {
      this.phase = "closed";
      throw new VoiceUnavailableError("auth_missing");
    }
    const wsBase = resolveVoiceSocketBase();
    if (!wsBase) {
      this.phase = "closed";
      throw new VoiceUnavailableError("backend_origin_missing");
    }
    if (!this.WebSocketImpl) {
      this.phase = "closed";
      throw new VoiceUnavailableError("unknown", {
        message: "WebSocket is not available in this runtime.",
      });
    }

    let ticket: { ticket: string; wsPath: string };
    try {
      ticket = await this.options.ticket();
    } catch (error) {
      this.phase = "closed";
      throw error;
    }
    if (this.phase !== "connecting") {
      // close() ran while the ticket was minting.
      throw new VoiceUnavailableError("closed");
    }

    const url = new URL(`${wsBase}${ticket.wsPath || "/api/one/voice/live"}`);
    url.searchParams.set("ticket", ticket.ticket);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown) => {
        if (settled) return;
        settled = true;
        this.rejectConnect = null;
        this.clearConnectTimer();
        if (error) reject(error);
        else resolve();
      };
      this.rejectConnect = (error) => settle(error);

      let ws: LiveSocket;
      try {
        ws = new this.WebSocketImpl!(url.toString());
      } catch (error) {
        this.phase = "closed";
        settle(new VoiceUnavailableError("network", { cause: error }));
        return;
      }
      this.ws = ws;

      const timeoutMs =
        this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      if (timeoutMs > 0) {
        this.connectTimer = setTimeout(() => {
          this.connectTimer = null;
          if (this.phase === "ready" || this.phase === "closed") return;
          this.localCloseReason = "connect_timeout";
          // Settle first so the typed reason is "timeout", not a generic close.
          settle(new VoiceUnavailableError("timeout"));
          this.safeClose(ws, 1000, "connect_timeout");
          this.finishClose({
            code: 1000,
            reason: "connect_timeout",
            clean: false,
            resumable: true,
          });
        }, timeoutMs);
      }

      ws.onopen = () => {
        if (this.ws !== ws || this.phase !== "connecting") return;
        this.phase = "open";
        // The auth frame is the FIRST frame on the wire, before any audio.
        const authFrame: ClientFrame = {
          type: "auth",
          vault_owner_token: auth.vaultOwnerToken,
          firebase_id_token: auth.firebaseIdToken ?? null,
          conversation_id: auth.conversationId,
          client: {
            platform: auth.client,
            protocol_version: ONE_VOICE_PROTOCOL_VERSION,
            input_mime_type: INPUT_MIME,
          },
          resume: Boolean(this.options.resume),
        };
        this.rawSend(ws, authFrame);
      };

      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        const frame = parseServerFrame(event.data);
        if (!frame) return;
        if (frame.type === "session.ready" && this.phase !== "ready") {
          this.phase = "ready";
          this.sessionIdValue = frame.session_id;
          this.options.onFrame(frame);
          this.startPing();
          this.flushOnsetBuffer();
          this.flushAppContext();
          settle();
          return;
        }
        if (frame.type === "error" && this.phase !== "ready") {
          this.options.onFrame(frame);
          settle(
            new VoiceUnavailableError(errorFrameReason(frame.code), {
              code: frame.code,
              message: frame.message,
            }),
          );
          return;
        }
        this.options.onFrame(frame);
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        if (this.phase !== "ready") {
          settle(new VoiceUnavailableError("network"));
        }
      };

      ws.onclose = (event) => {
        if (this.ws !== ws) return;
        const code = typeof event.code === "number" ? event.code : 1006;
        const reason = describeCloseCode(
          code,
          event.reason || this.localCloseReason || "",
        );
        const info: LiveCloseInfo = {
          code,
          reason,
          clean: Boolean(event.wasClean),
          resumable: this.localCloseReason ? false : isResumableCloseCode(code),
        };
        this.finishClose(info);
      };
    });
  }

  /**
   * Send `end`, close 1000, release timers. Reports `onClose` synchronously
   * with the local reason (the socket's own close event is then ignored).
   * Safe to call repeatedly.
   */
  close(reason = "ended"): void {
    if (this.phase === "closed") return;
    const ws = this.ws;
    this.localCloseReason = reason;
    if (ws && ws.readyState === SOCKET_OPEN) {
      this.rawSend(ws, { type: "end" });
    }
    if (
      ws &&
      (ws.readyState === SOCKET_OPEN || ws.readyState === SOCKET_CONNECTING)
    ) {
      this.safeClose(ws, 1000, reason);
    }
    this.finishClose({ code: 1000, reason, clean: true, resumable: false });
  }

  // -- outbound: audio -------------------------------------------------------

  /**
   * Queue or send one PCM16 (16 kHz mono) frame. Returns true when the frame
   * went on the wire, false when it was buffered or dropped.
   */
  sendAudio(pcm16: Uint8Array): boolean {
    if (this.phase === "closed" || pcm16.byteLength === 0) return false;
    if (!this.isReady) {
      if (this.onsetFlushed) return false;
      this.pushOnset(pcm16);
      return false;
    }
    const ws = this.ws!;
    const backlog = ws.bufferedAmount;
    if (backlog > BACKLOG_DROP_BYTES) {
      this.droppedBacklogFrames += 1;
      this.setDegraded(true);
      return false;
    }
    if (this.degraded && backlog <= BACKLOG_RECOVER_BYTES) {
      this.setDegraded(false);
    }
    const frameMs = pcm16DurationMs(pcm16.byteLength, INPUT_SAMPLE_RATE);
    const now = this.now();
    if (
      this.lastPacedSendAt !== null &&
      now - this.lastPacedSendAt < frameMs * PACING_GUARD_FRACTION
    ) {
      this.droppedPacingFrames += 1;
      return false;
    }
    this.lastPacedSendAt = now;
    this.sendAudioFrame(ws, pcm16);
    return true;
  }

  private pushOnset(pcm16: Uint8Array): void {
    const copy = pcm16.slice();
    this.onsetBuffer.push(copy);
    this.onsetBufferBytes += copy.byteLength;
    const maxBytes = (ONSET_BUFFER_MAX_MS / 1000) * INPUT_SAMPLE_RATE * 2;
    while (this.onsetBufferBytes > maxBytes && this.onsetBuffer.length > 1) {
      const dropped = this.onsetBuffer.shift();
      this.onsetBufferBytes -= dropped?.byteLength ?? 0;
    }
  }

  private flushOnsetBuffer(): void {
    if (this.onsetFlushed) return;
    this.onsetFlushed = true;
    const ws = this.ws;
    const frames = this.onsetBuffer;
    this.onsetBuffer = [];
    this.onsetBufferBytes = 0;
    if (!ws || ws.readyState !== SOCKET_OPEN) return;
    // Unpaced: this is a bounded, once-per-session catch-up, not a stall.
    for (const frame of frames) {
      this.sendAudioFrame(ws, frame);
      this.onsetFlushedFrames += 1;
    }
  }

  private sendAudioFrame(ws: LiveSocket, pcm16: Uint8Array): void {
    this.seq += 1;
    this.rawSend(ws, {
      type: "audio",
      data: base64FromBytes(pcm16),
      mime_type: INPUT_MIME,
      seq: this.seq,
    });
  }

  private setDegraded(degraded: boolean): void {
    if (this.degraded === degraded) return;
    this.degraded = degraded;
    this.options.onDegraded?.(degraded);
  }

  // -- outbound: control -----------------------------------------------------

  sendText(text: string): boolean {
    const clean = String(text || "").trim();
    if (!clean) return false;
    return this.sendControl({ type: "text", text: clean });
  }

  /**
   * Coalesced last-write-wins: several calls inside 150 ms produce one
   * frame carrying the latest context. Held until ready if needed.
   */
  sendAppContext(context: AppContextInput): void {
    if (this.phase === "closed") return;
    this.pendingAppContext = context;
    if (this.appContextTimer !== null) return;
    this.appContextTimer = setTimeout(() => {
      this.appContextTimer = null;
      this.flushAppContext();
    }, APP_CONTEXT_COALESCE_MS);
  }

  private flushAppContext(): void {
    if (!this.pendingAppContext || !this.isReady) return;
    if (this.appContextTimer !== null) {
      clearTimeout(this.appContextTimer);
      this.appContextTimer = null;
    }
    const context = this.pendingAppContext;
    this.pendingAppContext = null;
    this.sendControl({ type: "app_context", ...context });
  }

  pendingShown(pendingActionId: string): boolean {
    return this.sendControl({
      type: "pending_action.shown",
      pending_action_id: pendingActionId,
    });
  }

  confirm(
    pendingActionId: string,
    options: {
      receiptToken: string | null;
      firebaseIdToken?: string | null;
      consentVersion?: string | null;
    },
  ): boolean {
    return this.sendControl({
      type: "confirm_action",
      pending_action_id: pendingActionId,
      receipt_token: options.receiptToken ?? null,
      source: "tap",
      firebase_id_token: options.firebaseIdToken ?? null,
      consent_version: options.consentVersion ?? null,
    });
  }

  cancel(options: {
    pendingActionId?: string | null;
    scope: "pending_action" | "turn" | "session";
  }): boolean {
    return this.sendControl({
      type: "cancel_action",
      pending_action_id: options.pendingActionId ?? null,
      scope: options.scope,
    });
  }

  chooseCandidate(options: {
    kind?: "person" | "circle";
    id?: string | null;
    none?: boolean;
  }): boolean {
    return this.sendControl({
      type: "candidate.choose",
      ...(options.kind ? { kind: options.kind } : {}),
      id: options.id ?? null,
      none: Boolean(options.none),
    });
  }

  clientStepResult(
    stepId: string,
    status: "ok" | "failed",
    payload?: Record<string, unknown>,
  ): boolean {
    return this.sendControl({
      type: "client_step.result",
      step_id: stepId,
      status,
      ...(payload ? { payload } : {}),
    });
  }

  uiSettled(
    directiveId: string,
    status: "opened" | "failed" | "ignored",
  ): boolean {
    return this.sendControl({
      type: "ui.settled",
      directive_id: directiveId,
      status,
    });
  }

  interrupt(): boolean {
    return this.sendControl({ type: "interrupt" });
  }

  /** Control frames ignore the audio backlog guard: a confirm must land. */
  private sendControl(frame: ClientFrame): boolean {
    if (!this.isReady) return false;
    this.rawSend(this.ws!, frame);
    return true;
  }

  // -- internals -------------------------------------------------------------

  private rawSend(ws: LiveSocket, frame: ClientFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // A socket that throws on send is closing; onclose reports it.
    }
  }

  private safeClose(ws: LiveSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason.slice(0, 120));
    } catch {
      // ignore
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.isReady) return;
      this.rawSend(this.ws!, { type: "ping" });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private stopTimers(): void {
    this.stopPing();
    this.clearConnectTimer();
    if (this.appContextTimer !== null) {
      clearTimeout(this.appContextTimer);
      this.appContextTimer = null;
    }
    this.pendingAppContext = null;
  }

  private finishClose(info: LiveCloseInfo): void {
    this.stopTimers();
    const wasReady = this.phase === "ready";
    this.phase = "closed";
    this.onsetBuffer = [];
    this.onsetBufferBytes = 0;
    if (!wasReady && this.rejectConnect) {
      const reject = this.rejectConnect;
      this.rejectConnect = null;
      reject(
        new VoiceUnavailableError(
          this.localCloseReason ? "closed" : reasonForClose(info.code),
          {
            code: info.reason,
            message: `Voice connection closed before it was ready (${info.reason}).`,
          },
        ),
      );
    }
    if (this.closeReported) return;
    this.closeReported = true;
    this.options.onClose(info);
  }
}

function reasonForClose(code: number): VoiceUnavailableError["reason"] {
  switch (code) {
    case 4001:
      return "disabled";
    case 4003:
    case 4004:
      return "unauthorized";
    case 4013:
      return "provider_unavailable";
    case 4029:
      return "capacity";
    case 1006:
      return "network";
    default:
      return "unknown";
  }
}
