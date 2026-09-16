/**
 * ScriptedVoiceServer: a fake `one-voice-v1` relay for integration tests.
 *
 * Plays the server side of the socket: it records every frame the client
 * sends (parsed), answers `auth` with `session.ready` by default, and runs
 * scripted replies keyed by client frame type. Tests push server-initiated
 * frames (`push`) and close the socket with a code (`close`) to drive the
 * provider through pending actions, directives, client steps, reconnects,
 * and provider-unavailable closes.
 */

import type {
  LiveSocket,
  LiveSocketConstructor,
} from "@/lib/one-voice/live-client";
import {
  ONE_VOICE_PROTOCOL_VERSION,
  OUTPUT_MIME,
  type ClientFrame,
  type PendingActionFrame,
  type ServerFrame,
  type SessionReadyFrame,
} from "@/lib/one-voice/protocol";

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

export type ScriptedReply = (
  frame: ClientFrame,
  server: ScriptedVoiceServer,
) => ServerFrame[] | ServerFrame | void;

type Rule = {
  match: (frame: ClientFrame) => boolean;
  reply: ScriptedReply;
  once: boolean;
};

export class FakeLiveSocket implements LiveSocket {
  readyState = SOCKET_CONNECTING;
  bufferedAmount = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  readonly url: string;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(
    url: string,
    private readonly server: ScriptedVoiceServer,
  ) {
    this.url = url;
    queueMicrotask(() => {
      if (this.readyState !== SOCKET_CONNECTING) return;
      this.readyState = SOCKET_OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  send(data: string): void {
    if (this.readyState !== SOCKET_OPEN) throw new Error("socket is not open");
    const frame = JSON.parse(data) as ClientFrame;
    this.server.record(frame);
    const replies = this.server.replyTo(frame);
    for (const reply of replies) this.deliver(reply);
  }

  /** Client-initiated close: the close event arrives on the next microtask. */
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === SOCKET_CLOSED) return;
    this.readyState = SOCKET_CLOSED;
    queueMicrotask(() => this.emitClose(code ?? 1000, reason ?? "", true));
  }

  /** Server-initiated close: synchronous, like a frame from the wire. */
  serverClose(code: number, reason: string): void {
    if (this.readyState === SOCKET_CLOSED) return;
    this.readyState = SOCKET_CLOSED;
    this.emitClose(code, reason, true);
  }

  deliver(frame: ServerFrame): void {
    if (this.readyState !== SOCKET_OPEN) return;
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  private emitClose(code: number, reason: string, wasClean: boolean): void {
    this.onclose?.({ code, reason, wasClean } as CloseEvent);
  }
}

export function readyFrame(
  overrides: Partial<SessionReadyFrame> = {},
): SessionReadyFrame {
  return {
    type: "session.ready",
    protocol_version: ONE_VOICE_PROTOCOL_VERSION,
    session_id: "sess-1",
    conversation_id: "11111111-2222-4333-8444-555555555555",
    model: "gemini-live-test",
    resumed: false,
    idle_timeout_ms: 60_000,
    session_max_ms: 900_000,
    pending_actions: [],
    setup_progress: null,
    output_mime_type: OUTPUT_MIME,
    ...overrides,
  };
}

export function pendingActionFrame(
  overrides: Partial<PendingActionFrame> = {},
): PendingActionFrame {
  return {
    type: "pending_action",
    pending_action_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    tool: "share_with",
    gateway_action_id: "location.share_with",
    tier: "voice",
    summary: "Share your location with Priya for 1 hour",
    args: { duration_minutes: 60 },
    status: "pending",
    shown_at: null,
    expires_at: null,
    result: null,
    risk_level: "medium",
    requires_tap: false,
    entities: [
      {
        kind: "person",
        user_id: "user-priya",
        display_name: "Priya",
        relationship: "connected",
      },
    ],
    receipt_token: "receipt-1",
    ...overrides,
  };
}

export class ScriptedVoiceServer {
  readonly sent: ClientFrame[] = [];
  readonly sockets: FakeLiveSocket[] = [];
  readonly urls: string[] = [];
  private readonly rules: Rule[] = [];
  /** Answer `auth` with `session.ready` (the default); tests may replace it. */
  ready:
    | ((auth: Extract<ClientFrame, { type: "auth" }>) => SessionReadyFrame)
    | null = (auth) =>
    readyFrame({
      conversation_id: auth.conversation_id,
      resumed: Boolean(auth.resume),
    });

  readonly WebSocketImpl: LiveSocketConstructor;

  constructor() {
    const server = this;
    this.WebSocketImpl = class extends FakeLiveSocket {
      constructor(url: string) {
        super(url, server);
        server.sockets.push(this);
        server.urls.push(url);
      }
    };
  }

  get socket(): FakeLiveSocket {
    const current = this.sockets[this.sockets.length - 1];
    if (!current) throw new Error("no socket has been opened");
    return current;
  }

  /** Frames the client sent, optionally filtered by type. */
  frames<T extends ClientFrame["type"]>(
    type?: T,
  ): Array<Extract<ClientFrame, { type: T }>> {
    return (
      type ? this.sent.filter((frame) => frame.type === type) : this.sent
    ) as Array<Extract<ClientFrame, { type: T }>>;
  }

  /** The types of every frame sent so far, in order (audio collapsed). */
  sequence(): string[] {
    const output: string[] = [];
    for (const frame of this.sent) {
      if (frame.type === "audio" && output[output.length - 1] === "audio")
        continue;
      output.push(frame.type);
    }
    return output;
  }

  /** Script a reply for a client frame type. */
  on<T extends ClientFrame["type"]>(
    type: T,
    reply: (
      frame: Extract<ClientFrame, { type: T }>,
      server: ScriptedVoiceServer,
    ) => ServerFrame[] | ServerFrame | void,
    options: { once?: boolean } = {},
  ): this {
    this.rules.push({
      match: (frame) => frame.type === type,
      reply: reply as ScriptedReply,
      once: Boolean(options.once),
    });
    return this;
  }

  /** Server-initiated frame on the current socket. */
  push(frame: ServerFrame): void {
    this.socket.deliver(frame);
  }

  /** Close the current socket from the server side. */
  close(code: number, reason = ""): void {
    this.socket.serverClose(code, reason);
  }

  record(frame: ClientFrame): void {
    this.sent.push(frame);
  }

  replyTo(frame: ClientFrame): ServerFrame[] {
    const output: ServerFrame[] = [];
    if (frame.type === "auth" && this.ready) output.push(this.ready(frame));
    for (const rule of this.rules.slice()) {
      if (!rule.match(frame)) continue;
      if (rule.once) this.rules.splice(this.rules.indexOf(rule), 1);
      const replies = rule.reply(frame, this);
      if (!replies) continue;
      output.push(...(Array.isArray(replies) ? replies : [replies]));
    }
    return output;
  }
}
