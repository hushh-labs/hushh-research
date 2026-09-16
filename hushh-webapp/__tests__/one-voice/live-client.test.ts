import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/api-service", () => ({
  normalizeNativeBackendUrl: (raw: string) => raw.trim().replace(/\/$/, ""),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "web", isNativePlatform: () => false },
}));

import {
  APP_CONTEXT_COALESCE_MS,
  BACKLOG_DROP_BYTES,
  OneLiveClient,
  PING_INTERVAL_MS,
  describeCloseCode,
  isResumableCloseCode,
  resolveVoiceSocketBase,
  type LiveCloseInfo,
  type LiveSocket,
} from "@/lib/one-voice/live-client";
import { INPUT_MIME } from "@/lib/one-voice/protocol";
import { VoiceUnavailableError } from "@/lib/one-voice/ticket";

const CONVERSATION_ID = "0f4d8f2e-7c3a-4b1e-9d2f-5a6b7c8d9e01";
const FRAME_BYTES = 682 * 2; // one 2048-sample worklet frame at 48 kHz, downsampled to 16 kHz
const FRAME_MS = (FRAME_BYTES / 2 / 16000) * 1000;

class FakeSocket implements LiveSocket {
  static instances: FakeSocket[] = [];
  readonly url: string;
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 2;
  }

  // -- test drivers --
  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  serverClose(code: number, reason = "", wasClean = true): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean } as CloseEvent);
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  audioFrames(): Array<Record<string, unknown>> {
    return this.frames().filter((frame) => frame.type === "audio");
  }
}

const READY = {
  type: "session.ready",
  protocol_version: "one-voice-v1",
  session_id: "sess-1",
  conversation_id: CONVERSATION_ID,
  model: "gemini-live",
  resumed: false,
  idle_timeout_ms: 120_000,
  session_max_ms: 900_000,
  pending_actions: [],
  setup_progress: null,
  output_mime_type: "audio/pcm;rate=24000",
};

function frame(fill = 1): Uint8Array {
  return new Uint8Array(FRAME_BYTES).fill(fill);
}

type Harness = {
  client: OneLiveClient;
  socket: () => FakeSocket;
  frames: unknown[];
  closes: LiveCloseInfo[];
  degraded: boolean[];
  clock: { now: number };
  ticket: ReturnType<typeof vi.fn>;
};

function harness(
  overrides: Partial<ConstructorParameters<typeof OneLiveClient>[0]> = {},
): Harness {
  const frames: unknown[] = [];
  const closes: LiveCloseInfo[] = [];
  const degraded: boolean[] = [];
  const clock = { now: 1000 };
  const ticket = vi
    .fn()
    .mockResolvedValue({ ticket: "tkt-abc", wsPath: "/api/one/voice/live" });
  const client = new OneLiveClient({
    ticket,
    auth: () => ({
      vaultOwnerToken: "vault-owner-token",
      firebaseIdToken: "firebase-id-token",
      conversationId: CONVERSATION_ID,
      client: "web",
    }),
    onFrame: (value) => frames.push(value),
    onClose: (info) => closes.push(info),
    onDegraded: (value) => degraded.push(value),
    WebSocketImpl: FakeSocket,
    now: () => clock.now,
    ...overrides,
  });
  return {
    client,
    socket: () => {
      const socket = FakeSocket.instances.at(-1);
      if (!socket) throw new Error("no socket");
      return socket;
    },
    frames,
    closes,
    degraded,
    clock,
    ticket,
  };
}

/** Let the ticket promise resolve and the socket be constructed. */
async function settleTicket(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function connectReady(h: Harness): Promise<FakeSocket> {
  const pending = h.client.connect();
  await settleTicket();
  const socket = h.socket();
  socket.open();
  socket.receive(READY);
  await pending;
  return socket;
}

beforeEach(() => {
  FakeSocket.instances = [];
  process.env.BACKEND_URL = "http://localhost:8000";
  delete process.env.NEXT_PUBLIC_BACKEND_URL;
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("socket URL", () => {
  it("targets the configured backend over ws and carries only the ticket", async () => {
    const h = harness();
    const pending = h.client.connect();
    await settleTicket();
    const url = new URL(h.socket().url);
    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe("localhost:8000");
    expect(url.pathname).toBe("/api/one/voice/live");
    expect(url.searchParams.get("ticket")).toBe("tkt-abc");
    expect(Array.from(url.searchParams.keys())).toEqual(["ticket"]);
    expect(h.socket().url).not.toContain("googleapis.com");
    expect(h.socket().url).not.toContain("vault-owner-token");
    expect(h.socket().url).not.toContain("firebase-id-token");
    // jsdom's page origin is http://localhost (no port); never used as a base.
    expect(
      h
        .socket()
        .url.startsWith(`${window.location.origin.replace(/^http/, "ws")}/`),
    ).toBe(false);
    h.client.close("test");
    await expect(pending).rejects.toBeInstanceOf(VoiceUnavailableError);
  });

  it("rewrites https to wss", () => {
    process.env.BACKEND_URL = "https://api.example.test/";
    expect(resolveVoiceSocketBase()).toBe("wss://api.example.test");
  });

  it("refuses to connect without a backend origin instead of using the page origin", async () => {
    process.env.BACKEND_URL = "";
    process.env.NEXT_PUBLIC_BACKEND_URL = "";
    expect(resolveVoiceSocketBase()).toBe("");
    const h = harness();
    await expect(h.client.connect()).rejects.toMatchObject({
      reason: "backend_origin_missing",
    });
    expect(FakeSocket.instances).toHaveLength(0);
    expect(h.ticket).not.toHaveBeenCalled();
  });

  it("refuses to connect without auth", async () => {
    const h = harness({ auth: () => null });
    await expect(h.client.connect()).rejects.toMatchObject({
      reason: "auth_missing",
    });
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("surfaces a ticket mint failure unchanged", async () => {
    const h = harness({
      ticket: vi.fn().mockRejectedValue(new VoiceUnavailableError("disabled")),
    });
    await expect(h.client.connect()).rejects.toMatchObject({
      reason: "disabled",
    });
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

describe("handshake", () => {
  it("sends auth as the very first frame, with the bearer and proof off the URL", async () => {
    const h = harness();
    const pending = h.client.connect();
    await settleTicket();
    const socket = h.socket();
    expect(socket.sent).toHaveLength(0);
    socket.open();
    expect(socket.sent).toHaveLength(1);
    const auth = socket.frames()[0]!;
    expect(auth.type).toBe("auth");
    expect(auth.vault_owner_token).toBe("vault-owner-token");
    expect(auth.firebase_id_token).toBe("firebase-id-token");
    expect(auth.conversation_id).toBe(CONVERSATION_ID);
    expect(auth.resume).toBe(false);
    expect((auth.client as Record<string, unknown>).platform).toBe("web");
    socket.receive(READY);
    await pending;
    expect(h.client.state).toBe("ready");
    expect(h.client.sessionId).toBe("sess-1");
    expect(h.frames[0]).toMatchObject({ type: "session.ready" });
  });

  it("sends resume:true when asked", async () => {
    const h = harness({ resume: true });
    const socket = await connectReady(h);
    expect(socket.frames()[0]).toMatchObject({ type: "auth", resume: true });
  });

  it("rejects on an error frame before ready with a typed reason", async () => {
    const h = harness();
    const pending = h.client.connect();
    await settleTicket();
    const socket = h.socket();
    socket.open();
    socket.receive({
      type: "error",
      code: "ONE_VOICE_LIVE_DISABLED",
      message: "Voice is not available.",
    });
    await expect(pending).rejects.toMatchObject({
      reason: "disabled",
      code: "ONE_VOICE_LIVE_DISABLED",
    });
    expect(h.frames).toContainEqual(expect.objectContaining({ type: "error" }));
  });

  it("rejects when the socket closes before ready and reports the close code", async () => {
    const h = harness();
    const pending = h.client.connect();
    await settleTicket();
    const socket = h.socket();
    socket.open();
    socket.serverClose(4004, "ticket_expired", true);
    await expect(pending).rejects.toBeInstanceOf(VoiceUnavailableError);
    expect(h.closes).toEqual([
      { code: 4004, reason: "ticket_expired", clean: true, resumable: true },
    ]);
    expect(h.client.state).toBe("closed");
  });

  it("times out a handshake that never reaches ready", async () => {
    vi.useFakeTimers();
    const h = harness({ connectTimeoutMs: 5000 });
    const pending = h.client.connect();
    const rejected = expect(pending).rejects.toMatchObject({
      reason: "timeout",
    });
    await settleTicket();
    h.socket().open();
    vi.advanceTimersByTime(5000);
    await rejected;
    expect(h.closes).toHaveLength(1);
    expect(h.closes[0]).toMatchObject({
      code: 1000,
      reason: "connect_timeout",
    });
  });

  it("ignores frames that are not part of the protocol", async () => {
    const h = harness();
    const socket = await connectReady(h);
    socket.onmessage?.({ data: "not json" } as MessageEvent);
    socket.receive({ type: "made_up" });
    socket.receive({ type: "pong" });
    expect(h.frames.map((f) => (f as { type: string }).type)).toEqual([
      "session.ready",
      "pong",
    ]);
  });
});

describe("audio", () => {
  it("sends nothing before ready, then flushes the onset buffer once in order", async () => {
    const h = harness();
    const pending = h.client.connect();
    expect(h.client.sendAudio(frame(1))).toBe(false);
    await settleTicket();
    const socket = h.socket();
    socket.open();
    expect(h.client.sendAudio(frame(2))).toBe(false);
    expect(h.client.sendAudio(frame(3))).toBe(false);
    expect(socket.audioFrames()).toHaveLength(0);
    expect(h.client.stats().onsetBufferedFrames).toBe(3);

    socket.receive(READY);
    await pending;
    const flushed = socket.audioFrames();
    expect(flushed).toHaveLength(3);
    expect(flushed.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(flushed.every((f) => f.mime_type === INPUT_MIME)).toBe(true);
    // Order is preserved: decode the first byte of each payload.
    const firstBytes = flushed.map((f) => atob(String(f.data)).charCodeAt(0));
    expect(firstBytes).toEqual([1, 2, 3]);
    expect(h.client.stats()).toMatchObject({
      onsetBufferedFrames: 0,
      onsetFlushedFrames: 3,
    });

    // Auth was still the first frame on the wire.
    expect(socket.frames()[0]!.type).toBe("auth");
    // The first live frame right after the flush is not paced out.
    expect(h.client.sendAudio(frame(4))).toBe(true);
    expect(socket.audioFrames()).toHaveLength(4);
  });

  it("bounds the onset buffer to 1.5 s, keeping the newest audio", async () => {
    const h = harness();
    const pending = h.client.connect();
    await settleTicket();
    const socket = h.socket();
    socket.open();
    // 1 s frames: only the newest 1.5 s survive (two frames at most).
    const second = new Uint8Array(32_000);
    for (let i = 1; i <= 5; i += 1) h.client.sendAudio(second.fill(i));
    expect(h.client.stats().onsetBufferedFrames).toBe(1);
    socket.receive(READY);
    await pending;
    const flushed = socket.audioFrames();
    expect(flushed).toHaveLength(1);
    expect(atob(String(flushed[0]!.data)).charCodeAt(0)).toBe(5);
  });

  it("drops a frame that arrives inside a quarter of a frame interval (stall backlog)", async () => {
    const h = harness();
    const socket = await connectReady(h);
    expect(h.client.sendAudio(frame())).toBe(true);
    // Backlog draining ~0 ms apart.
    expect(h.client.sendAudio(frame())).toBe(false);
    h.clock.now += FRAME_MS * 0.2;
    expect(h.client.sendAudio(frame())).toBe(false);
    // Ordinary jitter (a merely-early frame) still goes through.
    h.clock.now += FRAME_MS * 0.1;
    expect(h.client.sendAudio(frame())).toBe(true);
    h.clock.now += FRAME_MS;
    expect(h.client.sendAudio(frame())).toBe(true);
    expect(socket.audioFrames()).toHaveLength(3);
    expect(h.client.stats().droppedPacingFrames).toBe(2);
  });

  it("drops audio only, and marks degraded, when the socket backlog exceeds 256 KB", async () => {
    const h = harness();
    const socket = await connectReady(h);
    socket.bufferedAmount = BACKLOG_DROP_BYTES + 1;
    expect(h.client.sendAudio(frame())).toBe(false);
    expect(h.client.stats()).toMatchObject({
      droppedBacklogFrames: 1,
      degraded: true,
      bufferedAmount: BACKLOG_DROP_BYTES + 1,
    });
    expect(h.degraded).toEqual([true]);
    // Control frames are never held back by the audio guard.
    expect(h.client.confirm("pa-1", { receiptToken: "rcpt" })).toBe(true);
    expect(
      h.client.cancel({ pendingActionId: "pa-1", scope: "pending_action" }),
    ).toBe(true);
    const control = socket
      .frames()
      .filter((f) => f.type === "confirm_action" || f.type === "cancel_action");
    expect(control).toHaveLength(2);
    expect(socket.audioFrames()).toHaveLength(0);
    // Recovery once the backlog drains past the hysteresis threshold.
    socket.bufferedAmount = 1024;
    h.clock.now += FRAME_MS;
    expect(h.client.sendAudio(frame())).toBe(true);
    expect(h.client.stats().degraded).toBe(false);
    expect(h.degraded).toEqual([true, false]);
  });

  it("encodes audio frames as base64 PCM with a monotonic seq", async () => {
    const h = harness();
    const socket = await connectReady(h);
    const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0]);
    h.client.sendAudio(bytes);
    const sent = socket.audioFrames()[0]!;
    expect(sent).toEqual({
      type: "audio",
      data: btoa("\x00\x40\x00\xc0"),
      mime_type: INPUT_MIME,
      seq: 1,
    });
  });

  it("ignores audio after close", async () => {
    const h = harness();
    await connectReady(h);
    h.client.close();
    expect(h.client.sendAudio(frame())).toBe(false);
  });
});

describe("control frames", () => {
  it("serialises every control frame per the protocol", async () => {
    const h = harness();
    const socket = await connectReady(h);
    expect(h.client.sendText("  share with Aisha  ")).toBe(true);
    expect(h.client.sendText("   ")).toBe(false);
    expect(h.client.pendingShown("pa-1")).toBe(true);
    expect(
      h.client.confirm("pa-1", {
        receiptToken: "rcpt",
        firebaseIdToken: "fb",
        consentVersion: "v3",
      }),
    ).toBe(true);
    expect(h.client.cancel({ scope: "turn" })).toBe(true);
    expect(h.client.chooseCandidate({ kind: "person", id: "user-1" })).toBe(
      true,
    );
    expect(h.client.chooseCandidate({ kind: "circle", none: true })).toBe(true);
    expect(h.client.clientStepResult("step-1", "ok", { published: 2 })).toBe(
      true,
    );
    expect(h.client.clientStepResult("step-2", "failed")).toBe(true);
    expect(h.client.uiSettled("dir-1", "opened")).toBe(true);
    expect(h.client.interrupt()).toBe(true);
    const sent = socket.frames().slice(1);
    expect(sent).toEqual([
      { type: "text", text: "share with Aisha" },
      { type: "pending_action.shown", pending_action_id: "pa-1" },
      {
        type: "confirm_action",
        pending_action_id: "pa-1",
        receipt_token: "rcpt",
        source: "tap",
        firebase_id_token: "fb",
        consent_version: "v3",
      },
      { type: "cancel_action", pending_action_id: null, scope: "turn" },
      { type: "candidate.choose", kind: "person", id: "user-1", none: false },
      { type: "candidate.choose", kind: "circle", id: null, none: true },
      {
        type: "client_step.result",
        step_id: "step-1",
        status: "ok",
        payload: { published: 2 },
      },
      { type: "client_step.result", step_id: "step-2", status: "failed" },
      { type: "ui.settled", directive_id: "dir-1", status: "opened" },
      { type: "interrupt" },
    ]);
  });

  it("refuses control frames before ready", async () => {
    const h = harness();
    const pending = h.client.connect();
    await settleTicket();
    const socket = h.socket();
    socket.open();
    expect(h.client.sendText("hello")).toBe(false);
    expect(h.client.confirm("pa-1", { receiptToken: null })).toBe(false);
    expect(h.client.interrupt()).toBe(false);
    expect(socket.frames().map((f) => f.type)).toEqual(["auth"]);
    h.client.close("test");
    await expect(pending).rejects.toBeInstanceOf(VoiceUnavailableError);
  });

  it("coalesces app_context last-write-wins inside 150 ms", async () => {
    vi.useFakeTimers();
    const h = harness();
    const socket = await connectReady(h);
    h.client.sendAppContext({
      screen_id: "one.location",
      route: "/one/location",
    });
    h.client.sendAppContext({
      screen_id: "one.location",
      route: "/one/location?action=share",
    });
    vi.advanceTimersByTime(APP_CONTEXT_COALESCE_MS - 1);
    h.client.sendAppContext({
      screen_id: "one.profile",
      route: "/one/profile",
    });
    expect(
      socket.frames().filter((f) => f.type === "app_context"),
    ).toHaveLength(0);
    vi.advanceTimersByTime(1);
    const contexts = socket.frames().filter((f) => f.type === "app_context");
    expect(contexts).toEqual([
      { type: "app_context", screen_id: "one.profile", route: "/one/profile" },
    ]);
    // A later call opens a new window.
    h.client.sendAppContext({ screen_id: "one.location" });
    vi.advanceTimersByTime(APP_CONTEXT_COALESCE_MS);
    expect(
      socket.frames().filter((f) => f.type === "app_context"),
    ).toHaveLength(2);
  });

  it("holds app_context until ready and sends it once", async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.client.connect();
    h.client.sendAppContext({ screen_id: "one.location" });
    vi.advanceTimersByTime(APP_CONTEXT_COALESCE_MS);
    await settleTicket();
    const socket = h.socket();
    socket.open();
    expect(
      socket.frames().filter((f) => f.type === "app_context"),
    ).toHaveLength(0);
    socket.receive(READY);
    await pending;
    expect(socket.frames().filter((f) => f.type === "app_context")).toEqual([
      { type: "app_context", screen_id: "one.location" },
    ]);
    vi.advanceTimersByTime(APP_CONTEXT_COALESCE_MS * 2);
    expect(
      socket.frames().filter((f) => f.type === "app_context"),
    ).toHaveLength(1);
  });
});

describe("keepalive and close", () => {
  it("pings every 20 s once ready and stops after close", async () => {
    vi.useFakeTimers();
    const h = harness();
    const socket = await connectReady(h);
    const pings = () => socket.frames().filter((f) => f.type === "ping").length;
    vi.advanceTimersByTime(PING_INTERVAL_MS - 1);
    expect(pings()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pings()).toBe(1);
    vi.advanceTimersByTime(PING_INTERVAL_MS * 2);
    expect(pings()).toBe(3);
    h.client.close("done");
    vi.advanceTimersByTime(PING_INTERVAL_MS * 3);
    expect(pings()).toBe(3);
  });

  it("close sends end, closes 1000, and reports once", async () => {
    const h = harness();
    const socket = await connectReady(h);
    h.client.close("user_stop");
    expect(socket.frames().at(-1)).toEqual({ type: "end" });
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "user_stop" }]);
    expect(h.closes).toEqual([
      { code: 1000, reason: "user_stop", clean: true, resumable: false },
    ]);
    // The socket's own close event does not report a second time.
    socket.serverClose(1000, "", true);
    h.client.close("again");
    expect(h.closes).toHaveLength(1);
    expect(h.client.state).toBe("closed");
  });

  it("surfaces server close codes with resumability", async () => {
    const cases: Array<[number, string, boolean]> = [
      [4001, "disabled", false],
      [4003, "auth", false],
      [4008, "protocol", false],
      [4009, "idle", true],
      [4010, "max_duration", true],
      [4013, "provider_unavailable", true],
      [4029, "capacity", true],
      [4030, "replaced", false],
      [1006, "abnormal", true],
    ];
    for (const [code, label, resumable] of cases) {
      FakeSocket.instances = [];
      const h = harness();
      const socket = await connectReady(h);
      socket.serverClose(code, "", code !== 1006);
      expect(h.closes).toEqual([
        { code, reason: label, clean: code !== 1006, resumable },
      ]);
      expect(h.client.state).toBe("closed");
      expect(isResumableCloseCode(code)).toBe(resumable);
    }
    expect(describeCloseCode(4009, " idle_timeout ")).toBe("idle_timeout");
    expect(describeCloseCode(4999)).toBe("close_4999");
  });

  it("forwards reconnect_required without reconnecting on its own", async () => {
    const h = harness();
    const socket = await connectReady(h);
    socket.receive({
      type: "session.reconnect_required",
      reason: "max_duration",
    });
    socket.serverClose(4010, "max_duration");
    expect(h.frames.at(-1)).toEqual({
      type: "session.reconnect_required",
      reason: "max_duration",
    });
    expect(FakeSocket.instances).toHaveLength(1);
    await expect(h.client.connect()).rejects.toMatchObject({
      reason: "closed",
    });
  });

  it("returns the same promise for a second connect while connecting", async () => {
    const h = harness();
    const first = h.client.connect();
    const second = h.client.connect();
    expect(second).toBe(first);
    await settleTicket();
    expect(h.ticket).toHaveBeenCalledTimes(1);
    h.socket().open();
    h.socket().receive(READY);
    await first;
  });
});
