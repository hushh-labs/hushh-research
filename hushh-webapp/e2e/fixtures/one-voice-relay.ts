import type { Page, WebSocketRoute } from "@playwright/test";

/**
 * Mocked One Live Voice relay for end-to-end specs.
 *
 * Intercepts the readiness flag, the ticket mint, the pending-action HTTP
 * twins, and the `/api/one/voice/live` WebSocket. A spec drives the
 * conversation by sending `text` frames through the panel's "Type instead"
 * affordance (or by injecting server frames directly), then asserts what the
 * real client sent and what the real UI rendered. No audio is ever asserted.
 *
 * The scripted server is deliberately dumb: it answers a client `text` frame
 * with the server frames the spec queued for that step, in order, so the UI
 * can only ever show what a server frame carried -- the same property the
 * production relay guarantees.
 */

export type ServerFrame = Record<string, unknown> & { type: string };
export type ClientFrame = Record<string, unknown> & { type: string };

export type RelayStep = {
  /** Matches the client frame that advances the script (default: any `text`). */
  when?: (frame: ClientFrame) => boolean;
  /** Server frames to emit, in order, once the matching client frame arrives. */
  reply: ServerFrame[];
};

export type MockedRelay = {
  /** Every frame the client sent, in order (auth first). */
  sent: ClientFrame[];
  /** Emit server frames outside the script (e.g. an unsolicited pending action). */
  emit: (frames: ServerFrame[]) => void;
  /** Resolve once the client has sent a frame matching the predicate. */
  waitFor: (
    predicate: (frame: ClientFrame) => boolean,
    timeoutMs?: number,
  ) => Promise<ClientFrame>;
  readinessCalls: number;
  ticketCalls: number;
  confirmCalls: string[];
  cancelCalls: string[];
};

const CONVERSATION_ID = "11111111-2222-4333-8444-555555555555";

export function pendingAction(
  overrides: Partial<ServerFrame> & {
    pending_action_id: string;
    tool: string;
    summary: string;
    tier: "voice" | "tap";
  },
): ServerFrame {
  return {
    type: "pending_action",
    gateway_action_id: "location.send_request",
    args: {},
    status: "pending",
    shown_at: null,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    result: null,
    risk_level: overrides.tier === "tap" ? "high" : "medium",
    requires_tap: overrides.tier === "tap",
    entities: [],
    ...(overrides.tier === "tap" ? { receipt_token: "receipt-e2e" } : {}),
    ...overrides,
  };
}

export function toolResult(
  tool: string,
  result: Record<string, unknown>,
): ServerFrame {
  const status = String(result.status ?? "ok");
  const notSuccess = new Set([
    "rejected",
    "unsupported",
    "confirmation_required",
    "tap_required",
    "navigation_dispatched",
    "grant_created",
    "pending",
  ]);
  return {
    type: "tool.result",
    call_id: null,
    tool,
    status,
    ok: !notSuccess.has(status),
    result_public: { spoken_facts: [], ...result, status },
  };
}

export function sessionReady(extra: Partial<ServerFrame> = {}): ServerFrame {
  return {
    type: "session.ready",
    protocol_version: "one-voice-v1",
    session_id: "e2e-session",
    conversation_id: CONVERSATION_ID,
    model: "gemini-live-2.5-flash-native-audio",
    resumed: false,
    idle_timeout_ms: 90_000,
    session_max_ms: 1_800_000,
    pending_actions: [],
    setup_progress: null,
    output_mime_type: "audio/pcm;rate=24000",
    ...extra,
  };
}

export async function mockVoiceRelay(
  page: Page,
  steps: RelayStep[],
): Promise<MockedRelay> {
  const state: MockedRelay = {
    sent: [],
    emit: () => undefined,
    waitFor: async () => {
      throw new Error("socket not open");
    },
    readinessCalls: 0,
    ticketCalls: 0,
    confirmCalls: [],
    cancelCalls: [],
  };
  const waiters: Array<{
    predicate: (frame: ClientFrame) => boolean;
    resolve: (frame: ClientFrame) => void;
  }> = [];
  const queue = [...steps];

  await page.route("**/api/one/voice/readiness", async (route) => {
    state.readinessCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        status: "ready",
        model: "gemini-live-2.5-flash-native-audio",
        location: "us-central1",
        protocol_version: "one-voice-v1",
        ws_path: "/api/one/voice/live",
      }),
    });
  });
  await page.route("**/api/one/voice/sessions", async (route) => {
    state.ticketCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ticket: "v1.e2e.ticket",
        expires_at: Math.floor(Date.now() / 1000) + 60,
        session_id: "e2e-session",
        ws_path: "/api/one/voice/live",
        protocol_version: "one-voice-v1",
      }),
    });
  });
  await page.route(
    "**/api/one/voice/pending-actions/*/confirm",
    async (route) => {
      state.confirmCalls.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          pending_action: null,
          result: { status: "ok" },
        }),
      });
    },
  );
  await page.route(
    "**/api/one/voice/pending-actions/*/cancel",
    async (route) => {
      state.cancelCalls.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ pending_action: { status: "cancelled" } }),
      });
    },
  );

  await page.routeWebSocket(/\/api\/one\/voice\/live/, (ws: WebSocketRoute) => {
    const send = (frame: ServerFrame) => ws.send(JSON.stringify(frame));
    state.emit = (frames) => frames.forEach(send);
    state.waitFor = (predicate, timeoutMs = 10_000) =>
      new Promise<ClientFrame>((resolve, reject) => {
        const existing = state.sent.find(predicate);
        if (existing) return resolve(existing);
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for client frame")),
          timeoutMs,
        );
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    ws.onMessage((raw) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(raw)) as ClientFrame;
      } catch {
        return;
      }
      state.sent.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(frame)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
      if (frame.type === "auth") {
        send(sessionReady({ conversation_id: String(frame.conversation_id) }));
        send({ type: "state", state: "listening", turn_id: null });
        return;
      }
      if (frame.type === "ping") {
        send({ type: "pong" });
        return;
      }
      if (frame.type === "audio") return;
      const step = queue[0];
      const matches = step
        ? step.when
          ? step.when(frame)
          : frame.type === "text"
        : false;
      if (step && matches) {
        queue.shift();
        if (frame.type === "text") {
          send({
            type: "transcript.input",
            text: String(frame.text),
            final: true,
            turn_id: "t-e2e",
          });
        }
        step.reply.forEach(send);
      }
    });
  });

  return state;
}

export { CONVERSATION_ID };
