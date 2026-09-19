import { describe, expect, it } from "vitest";

import {
  CLOSE_CODES,
  NOT_SUCCESS_STATUSES,
  type ServerFrame,
  type ToolResultFrame,
} from "@/lib/one-voice/protocol";
import {
  SOS_CLOSED_UNVERIFIED_FACT,
  SOS_CLOSED_UNVERIFIED_REASON,
  VOICE_UNAVAILABLE_MESSAGE,
  canAutoReconnect,
  hasOpenPendingAction,
  isNeutralStatus,
  isPendingStatus,
  isSuccessStatus,
  localCloseReason,
  reduceVoiceSession,
  selectSuccessReceipt,
  settleArmedSosOnClose,
  toolResultTone,
  voiceErrorForClose,
} from "@/lib/one-voice/session-reducer";
import {
  INITIAL_VOICE_SESSION_STATE,
  type VoicePhase,
  type VoiceSessionEvent,
  type VoiceSessionState,
} from "@/lib/one-voice/session-types";

import { pendingActionFrame, readyFrame } from "./fixtures/scripted-server";

const NOW = 1_700_000_000_000;

function server(frame: ServerFrame, now = NOW): VoiceSessionEvent {
  return { type: "server", frame, now };
}

function run(
  events: VoiceSessionEvent[],
  start: VoiceSessionState = INITIAL_VOICE_SESSION_STATE,
): VoiceSessionState {
  return events.reduce(
    (state, event) => reduceVoiceSession(state, event),
    start,
  );
}

function connected(
  conversationId = "11111111-2222-4333-8444-555555555555",
): VoiceSessionState {
  return run([
    { type: "connecting", conversationId },
    server(readyFrame({ conversation_id: conversationId })),
  ]);
}

function toolResult(overrides: Partial<ToolResultFrame> = {}): ToolResultFrame {
  return {
    type: "tool.result",
    call_id: "call-1",
    tool: "share_with",
    status: "share_created",
    ok: true,
    result_public: {
      status: "share_created",
      spoken_facts: ["Sharing with Priya for an hour."],
    },
    ...overrides,
  };
}

const SUCCESS_LOOKING: ReadonlySet<VoicePhase> = new Set([
  "complete",
  "executing",
]);

describe("reduceVoiceSession: lifecycle", () => {
  it("starts listening on session.ready and carries the session facts", () => {
    const state = connected();
    expect(state.phase).toBe("listening");
    expect(state.sessionId).toBe("sess-1");
    expect(state.conversationId).toBe("11111111-2222-4333-8444-555555555555");
    expect(state.model).toBe("gemini-live-test");
    expect(state.idleTimeoutMs).toBe(60_000);
    expect(state.error).toBeNull();
    expect(state.pendingAction).toBeNull();
  });

  it("a new conversation resets everything but the device toggles", () => {
    const before = run([
      { type: "muted", muted: true },
      { type: "half_duplex", enabled: true },
    ]);
    const state = run([{ type: "connecting", conversationId: "c-1" }], before);
    expect(state.phase).toBe("connecting");
    expect(state.muted).toBe(true);
    expect(state.halfDuplex).toBe(true);
    expect(state.transcript).toEqual([]);
  });

  it("maps every server state, keeping paused and error over a relay 'listening'", () => {
    const base = connected();
    for (const value of [
      "understanding",
      "asking",
      "confirming",
      "executing",
      "complete",
      "error",
    ] as const) {
      expect(run([server({ type: "state", state: value })], base).phase).toBe(
        value,
      );
    }
    const paused = run([{ type: "paused" }], base);
    expect(
      run([server({ type: "state", state: "listening" })], paused).phase,
    ).toBe("paused");
    const errored = run(
      [server({ type: "error", code: "fatal", message: "x" })],
      base,
    );
    expect(
      run([server({ type: "state", state: "listening" })], errored).phase,
    ).toBe("error");
  });

  it("arms the idle deadline on complete and clears it on activity", () => {
    const complete = run(
      [server({ type: "state", state: "complete" }, NOW)],
      connected(),
    );
    expect(complete.idleDeadlineAt).toBe(NOW + 60_000);
    const active = run(
      [
        server({
          type: "transcript.input",
          text: "hi",
          final: false,
          turn_id: "t1",
        }),
      ],
      complete,
    );
    expect(active.idleDeadlineAt).toBeNull();
  });

  it("closed lands idle; a 4013 close explains and never retries elsewhere", () => {
    const state = run(
      [
        {
          type: "closed",
          code: CLOSE_CODES.providerUnavailable,
          reason: "provider_unavailable",
          now: NOW,
        },
      ],
      connected(),
    );
    expect(state.phase).toBe("idle");
    expect(state.error).toEqual({
      code: "voice_unavailable",
      message: VOICE_UNAVAILABLE_MESSAGE,
      recoverable: false,
    });
    expect(state.error?.message).toBe(
      "Voice is unavailable right now. You can keep typing to One.",
    );
  });

  it("only idle (4009) and a clean end (1000) are recoverable closes", () => {
    for (const code of [CLOSE_CODES.idle, CLOSE_CODES.ended]) {
      expect(voiceErrorForClose(code, "")).toBeNull();
      const state = run(
        [{ type: "closed", code, reason: "", now: NOW }],
        connected(),
      );
      expect(state.error).toBeNull();
      expect(state.phase).toBe("idle");
    }
    for (const code of [
      CLOSE_CODES.auth,
      CLOSE_CODES.capacity,
      CLOSE_CODES.replaced,
      1006,
    ]) {
      const state = run(
        [{ type: "closed", code, reason: "", now: NOW }],
        connected(),
      );
      expect(state.error?.recoverable).toBe(false);
    }
  });

  it("reconnect_required then a server close keeps the conversation and goes back to connecting", () => {
    const asked = run(
      [server({ type: "session.reconnect_required", reason: "go_away" })],
      connected(),
    );
    expect(asked.reconnectReason).toBe("go_away");
    expect(canAutoReconnect(asked)).toBe(true);
    const closed = run(
      [{ type: "closed", code: 1000, reason: "go_away", now: NOW }],
      asked,
    );
    expect(closed.phase).toBe("connecting");
    expect(closed.error).toBeNull();
    expect(closed.conversationId).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("a local stop after reconnect_required never reconnects", () => {
    const asked = run(
      [server({ type: "session.reconnect_required", reason: "max_duration" })],
      connected(),
    );
    const closed = run(
      [
        {
          type: "closed",
          code: 1000,
          reason: localCloseReason("tap"),
          now: NOW,
        },
      ],
      asked,
    );
    expect(closed.phase).toBe("idle");
    expect(closed.reconnectReason).toBeNull();
  });

  it("an open confirmation card blocks the silent reconnect", () => {
    const withCard = run(
      [
        server(pendingActionFrame()),
        server({ type: "session.reconnect_required", reason: "go_away" }),
      ],
      connected(),
    );
    expect(hasOpenPendingAction(withCard)).toBe(true);
    expect(canAutoReconnect(withCard)).toBe(false);
    const closed = run(
      [{ type: "closed", code: 1000, reason: "go_away", now: NOW }],
      withCard,
    );
    expect(closed.phase).toBe("idle");
  });

  it("paused then resumed follows the last server state; resumed is a no-op otherwise", () => {
    const base = run([server({ type: "state", state: "asking" })], connected());
    const paused = run([{ type: "paused" }], base);
    expect(paused.phase).toBe("paused");
    expect(paused.speaking).toBe(false);
    expect(run([{ type: "resumed" }], paused).phase).toBe("asking");
    expect(run([{ type: "resumed" }], base)).toBe(base);
    expect(run([{ type: "paused" }])).toBe(INITIAL_VOICE_SESSION_STATE);
  });

  it("local facts are idempotent", () => {
    const base = connected();
    expect(run([{ type: "speaking", speaking: false }], base)).toBe(base);
    expect(run([{ type: "level", level: 0 }], base)).toBe(base);
    expect(run([{ type: "degraded", degraded: true }], base).degraded).toBe(
      true,
    );
    expect(run([{ type: "muted", muted: true }], base).muted).toBe(true);
    expect(run([server({ type: "pong" })], base)).toBe(base);
    expect(run([{ type: "reset" }], base)).toBe(INITIAL_VOICE_SESSION_STATE);
  });
});

describe("reduceVoiceSession: transcript", () => {
  it("appends and replaces partial lines by turn and role; 'You said' is role you", () => {
    const state = run(
      [
        server({
          type: "transcript.input",
          text: "share my",
          final: false,
          turn_id: "t1",
        }),
        server({
          type: "transcript.input",
          text: "share my location",
          final: true,
          turn_id: "t1",
        }),
        server({
          type: "transcript.output",
          text: "Sure",
          final: false,
          turn_id: "t1",
        }),
        server({
          type: "transcript.output",
          text: ", with whom?",
          final: false,
          turn_id: "t1",
        }),
        server({ type: "turn", state: "model_end", turn_id: "t1" }),
      ],
      connected(),
    );
    expect(
      state.transcript.map((item) => [item.role, item.text, item.final]),
    ).toEqual([
      ["you", "share my location", true],
      ["one", "Sure, with whom?", true],
    ]);
  });

  it("an interrupted turn fences the model's partial line", () => {
    const state = run(
      [
        server({
          type: "transcript.output",
          text: "Let me",
          final: false,
          turn_id: "t2",
        }),
        server({ type: "turn", state: "interrupted", turn_id: "t2" }),
      ],
      connected(),
    );
    expect(state.transcript[0]?.final).toBe(true);
  });

  it("property: no transcript frame ever produces a success-looking phase or receipt", () => {
    const phrases = [
      "done, you are now sharing with Priya",
      "Location sharing is on",
      "I turned sharing on",
      "executed",
      "complete",
      "ok",
    ];
    for (const text of phrases) {
      for (const type of ["transcript.input", "transcript.output"] as const) {
        for (const final of [true, false]) {
          const state = run(
            [server({ type, text, final, turn_id: "t9" })],
            connected(),
          );
          expect(SUCCESS_LOOKING.has(state.phase)).toBe(false);
          expect(state.phase).toBe("listening");
          expect(state.lastResult).toBeNull();
          expect(state.pendingAction).toBeNull();
          expect(selectSuccessReceipt(state)).toBeNull();
        }
      }
    }
  });
});

describe("reduceVoiceSession: tools and success", () => {
  it("(1) setup consent frames: a tap card, then the executed resolution is the receipt", () => {
    const card = pendingActionFrame({
      pending_action_id: "11111111-aaaa-4bbb-8ccc-dddddddddddd",
      tool: "accept_location_setup_consent",
      gateway_action_id: "location.setup.accept_consent",
      tier: "tap",
      summary: "Accept the Location sharing consent",
      args: { consent_version: "2026-09" },
      risk_level: "high",
      requires_tap: true,
      entities: [],
      receipt_token: "receipt-consent",
    });
    const shown = run(
      [server({ type: "state", state: "confirming" }), server(card)],
      connected(),
    );
    expect(shown.phase).toBe("confirming");
    expect(shown.pendingAction?.requiresTap).toBe(true);
    expect(shown.pendingAction?.riskLevel).toBe("high");
    expect(shown.pendingAction?.receiptToken).toBe("receipt-consent");
    expect(selectSuccessReceipt(shown)).toBeNull();

    const executed = run(
      [
        server({ type: "state", state: "executing" }),
        server({
          type: "pending_action.resolved",
          pending_action_id: card.pending_action_id,
          status: "executed",
          result_public: { status: "accepted", ui_refresh: ["location_setup"] },
        }),
      ],
      shown,
    );
    expect(executed.phase).toBe("complete");
    expect(executed.pendingAction?.resolvedStatus).toBe("executed");
    expect(executed.pendingAction?.receiptToken).toBeNull();
    expect(selectSuccessReceipt(executed)).toMatchObject({
      source: "pending_action.resolved",
      tool: "accept_location_setup_consent",
      status: "accepted",
    });
  });

  it("(3) a no_connections tool result is ok on the wire but never success", () => {
    const state = run(
      [
        server({
          type: "tool.started",
          call_id: "call-1",
          tool: "list_people",
          args_public: {},
        }),
        server(
          toolResult({
            tool: "list_people",
            status: "no_connections",
            ok: true,
            result_public: {
              status: "no_connections",
              spoken_facts: ["You have no connections yet."],
            },
          }),
        ),
        server({ type: "state", state: "complete" }),
      ],
      connected(),
    );
    expect(state.toolTimeline).toHaveLength(1);
    expect(state.toolTimeline[0]?.ok).toBe(true);
    expect(state.lastResult?.status).toBe("no_connections");
    expect(isSuccessStatus("no_connections")).toBe(false);
    expect(toolResultTone("no_connections", true)).toBe("neutral");
    expect(selectSuccessReceipt(state)).toBeNull();
  });

  it("(3b) ok:false is never success even with a success-looking status", () => {
    const state = run(
      [server(toolResult({ ok: false, status: "share_created" }))],
      connected(),
    );
    expect(toolResultTone("share_created", false)).toBe("failure");
    expect(selectSuccessReceipt(state)).toBeNull();
  });

  it("device Location switch tones: on/off succeed, already_* are neutral, pending and rejected fail", () => {
    expect(toolResultTone("on", true)).toBe("success");
    expect(toolResultTone("off", true)).toBe("success");
    expect(toolResultTone("already_on", true)).toBe("neutral");
    expect(toolResultTone("already_off", true)).toBe("neutral");
    expect(toolResultTone("location_updates_pending", false)).toBe("failure");
    // Even a mis-flagged ok:true pending frame never reads as done.
    expect(toolResultTone("location_updates_pending", true)).toBe("failure");
    expect(toolResultTone("rejected", true)).toBe("failure");
    expect(toolResultTone("rejected", false)).toBe("failure");
    expect(NOT_SUCCESS_STATUSES.has("location_updates_pending")).toBe(true);
    expect(isSuccessStatus("location_updates_pending")).toBe(false);
    expect(isSuccessStatus("already_on")).toBe(false);
    expect(isSuccessStatus("on")).toBe(true);
  });

  it("the settled device result replaces the location_updates_pending timeline item instead of appending", () => {
    const pending = run(
      [
        server({ type: "state", state: "executing" }),
        server({
          type: "tool.started",
          call_id: "c-device",
          tool: "pause_device_location_updates",
          args_public: {},
        }),
        server(
          toolResult({
            call_id: "c-device",
            tool: "pause_device_location_updates",
            status: "location_updates_pending",
            ok: false,
            result_public: { status: "location_updates_pending" },
          }),
        ),
      ],
      connected(),
    );
    expect(pending.toolTimeline).toHaveLength(1);
    expect(pending.toolTimeline[0]).toMatchObject({
      callId: "c-device",
      ok: false,
      result: { status: "location_updates_pending" },
    });
    expect(pending.lastResult?.status).toBe("location_updates_pending");
    expect(selectSuccessReceipt(pending)).toBeNull();
    expect(pending.phase).not.toBe("complete");

    const settled = run(
      [
        server(
          toolResult({
            call_id: "c-device",
            tool: "pause_device_location_updates",
            status: "off",
            ok: true,
            result_public: {
              status: "off",
              spoken_facts: ["Location is off."],
            },
          }),
        ),
        server({ type: "state", state: "complete" }),
      ],
      pending,
    );
    expect(settled.toolTimeline).toHaveLength(1);
    expect(settled.toolTimeline[0]).toMatchObject({
      callId: "c-device",
      tool: "pause_device_location_updates",
      ok: true,
      result: { status: "off" },
    });
    expect(selectSuccessReceipt(settled)).toMatchObject({
      source: "tool.result",
      tool: "pause_device_location_updates",
      status: "off",
    });

    // A settled item is final: a later result on the same call id is a new row.
    const again = run(
      [
        server(
          toolResult({
            call_id: "c-device",
            tool: "pause_device_location_updates",
            status: "already_off",
            ok: true,
            result_public: { status: "already_off" },
          }),
        ),
      ],
      settled,
    );
    expect(again.toolTimeline).toHaveLength(2);
    expect(selectSuccessReceipt(again)).toBeNull();
  });

  it("a tool.result ok:true with a success status is the only tool receipt", () => {
    const state = run(
      [
        server({
          type: "tool.started",
          call_id: "call-1",
          tool: "share_with",
          args_public: { duration: 60 },
        }),
        server(toolResult()),
      ],
      connected(),
    );
    expect(state.toolTimeline[0]?.argsSummary).toBe("duration: 60");
    expect(selectSuccessReceipt(state)).toMatchObject({
      source: "tool.result",
      tool: "share_with",
      status: "share_created",
    });
  });

  it("(4) candidate_picker shows only what the server sent and clears on dismiss or a card", () => {
    const picked = run(
      [
        server({
          type: "candidate_picker",
          kind: "person",
          question: "Which Priya?",
          candidates: [
            {
              user_id: "u-1",
              display_name: "Priya Sharma",
              relationship: "connected",
            },
            {
              user_id: "u-2",
              display_name: "Priya Nair",
              relationship: "pending_outgoing",
            },
          ],
        }),
      ],
      connected(),
    );
    expect(picked.candidatePicker?.question).toBe("Which Priya?");
    expect(
      picked.candidatePicker?.candidates.map(
        (candidate) => candidate.display_name,
      ),
    ).toEqual(["Priya Sharma", "Priya Nair"]);
    expect(
      run([{ type: "dismiss_candidates" }], picked).candidatePicker,
    ).toBeNull();
    expect(
      run([server(pendingActionFrame())], picked).candidatePicker,
    ).toBeNull();
  });

  it("(5) two pending actions in order: the newest is on screen; a stale resolution never clears it", () => {
    const first = pendingActionFrame({
      pending_action_id: "11111111-0000-4000-8000-000000000001",
      summary: "first",
    });
    const second = pendingActionFrame({
      pending_action_id: "11111111-0000-4000-8000-000000000002",
      summary: "second",
      receipt_token: "receipt-2",
    });
    const both = run([server(first), server(second)], connected());
    expect(both.pendingAction?.summary).toBe("second");
    const stale = run(
      [
        server({
          type: "pending_action.resolved",
          pending_action_id: first.pending_action_id,
          status: "cancelled",
          result_public: null,
        }),
      ],
      both,
    );
    expect(stale.pendingAction?.summary).toBe("second");
    expect(stale.pendingAction?.resolvedStatus).toBeNull();
    expect(stale.phase).toBe("confirming");
    const done = run(
      [
        server({
          type: "pending_action.resolved",
          pending_action_id: second.pending_action_id,
          status: "executed",
          result_public: { status: "share_created" },
        }),
      ],
      stale,
    );
    expect(done.phase).toBe("complete");
    expect(selectSuccessReceipt(done)?.status).toBe("share_created");
  });

  it("(7) cancel clears the receipt and returns to listening without success", () => {
    const card = pendingActionFrame();
    const cancelled = run(
      [
        server(card),
        server({
          type: "pending_action.resolved",
          pending_action_id: card.pending_action_id,
          status: "cancelled",
          result_public: null,
        }),
      ],
      connected(),
    );
    expect(cancelled.phase).toBe("listening");
    expect(cancelled.pendingAction?.resolvedStatus).toBe("cancelled");
    expect(cancelled.pendingAction?.receiptToken).toBeNull();
    expect(cancelled.pendingAction?.status).toBe("cancelled");
    expect(selectSuccessReceipt(cancelled)).toBeNull();
    expect(hasOpenPendingAction(cancelled)).toBe(false);
  });

  it("a not_pending resolution keeps the row status and is not success", () => {
    const card = pendingActionFrame();
    const state = run(
      [
        server(card),
        server({
          type: "pending_action.resolved",
          pending_action_id: card.pending_action_id,
          status: "not_pending",
          result_public: {
            status: "not_pending",
            reason_code: "receipt_invalid",
          },
        }),
      ],
      connected(),
    );
    expect(state.pendingAction?.status).toBe("pending");
    expect(state.pendingAction?.resolvedStatus).toBe("not_pending");
    expect(selectSuccessReceipt(state)).toBeNull();
  });

  it("(9) state complete without a tool.result renders no success", () => {
    const state = run(
      [
        server({ type: "state", state: "understanding" }),
        server({ type: "state", state: "complete" }),
      ],
      connected(),
    );
    expect(state.phase).toBe("complete");
    expect(state.lastResult).toBeNull();
    expect(selectSuccessReceipt(state)).toBeNull();
  });

  it("session.ready re-lists open cards: same id keeps the local receipt, a vanished card clears", () => {
    const card = pendingActionFrame();
    const withCard = run([server(card)], connected());
    const {
      type: _type,
      risk_level: _r,
      requires_tap: _t,
      entities: _e,
      receipt_token: _k,
      ...row
    } = card;
    void _type;
    void _r;
    void _t;
    void _e;
    void _k;
    const relisted = run(
      [
        { type: "connecting", conversationId: withCard.conversationId! },
        server(readyFrame({ pending_actions: [row] })),
      ],
      withCard,
    );
    expect(relisted.phase).toBe("confirming");
    expect(relisted.pendingAction?.receiptToken).toBe("receipt-1");
    expect(relisted.pendingAction?.entities[0]?.display_name).toBe("Priya");
    const vanished = run(
      [
        { type: "connecting", conversationId: withCard.conversationId! },
        server(readyFrame()),
      ],
      withCard,
    );
    expect(vanished.pendingAction).toBeNull();
    expect(vanished.phase).toBe("listening");
  });

  it("entity cards dedupe by id and never invent one without an id", () => {
    const state = run(
      [
        server({
          type: "entity_card",
          kind: "person",
          user_id: "u-1",
          display_name: "Priya",
        }),
        server({
          type: "entity_card",
          kind: "person",
          user_id: "u-1",
          display_name: "Priya S.",
        }),
        server({
          type: "entity_card",
          kind: "circle",
          circle_id: "c-1",
          name: "Family",
          member_count: 4,
        }),
      ],
      connected(),
    );
    expect(state.entities).toHaveLength(2);
    expect(state.entities[0]).toMatchObject({ kind: "circle", name: "Family" });
    expect(state.entities[1]).toMatchObject({
      kind: "person",
      display_name: "Priya S.",
    });
  });

  it("client steps are held until reported", () => {
    const requested = run(
      [
        server({
          type: "client_step.request",
          step_id: "step-1",
          kind: "publish_location_envelopes",
          payload: {},
          timeout_s: 20,
        }),
      ],
      connected(),
    );
    expect(requested.clientStep?.stepId).toBe("step-1");
    expect(
      run([{ type: "client_step_done", stepId: "other" }], requested),
    ).toBe(requested);
    expect(
      run([{ type: "client_step_done", stepId: "step-1" }], requested)
        .clientStep,
    ).toBeNull();
  });

  it("informational error frames keep the phase; fatal ones do not", () => {
    const base = connected();
    const informational = run(
      [
        server({
          type: "error",
          code: "firebase_proof_required",
          message: "Sign-in proof is required.",
        }),
      ],
      base,
    );
    expect(informational.phase).toBe("listening");
    expect(informational.error?.recoverable).toBe(true);
    const fatal = run(
      [
        server({
          type: "error",
          code: "ONE_VOICE_LIVE_DISABLED",
          message: "off",
        }),
      ],
      base,
    );
    expect(fatal.phase).toBe("error");
    expect(fatal.error?.message).toBe(VOICE_UNAVAILABLE_MESSAGE);
  });
});

describe("reduceVoiceSession: Save My Soul", () => {
  const ARMED = {
    status: "sos_grants_created",
    spoken_facts: ["Alert armed for Priya; sending your position now."],
    grant_ids: ["grant_SECRET_a"],
    armed: [
      {
        grant_id: "grant_SECRET_a",
        user_id: "usr_SECRET_priya",
        display_name: "Priya",
      },
    ],
    client_step: {
      kind: "publish_location_envelopes",
      purpose: "sos",
      sos: true,
      grant_ids: ["grant_SECRET_a"],
    },
  };

  function armed(): VoiceSessionState {
    const card = pendingActionFrame({
      tool: "trigger_save_my_soul",
      gateway_action_id: "location.trigger_sos",
      tier: "tap",
      requires_tap: true,
      receipt_token: "receipt-sos",
      entities: [],
    });
    return run(
      [
        server(card),
        server({ type: "state", state: "executing" }),
        server({
          type: "pending_action.resolved",
          pending_action_id: card.pending_action_id,
          status: "executed",
          result_public: ARMED,
        }),
        server(
          toolResult({
            call_id: null,
            tool: "trigger_save_my_soul",
            status: "sos_grants_created",
            ok: false,
            result_public: { ...ARMED },
          }),
        ),
        server({ type: "state", state: "listening" }),
      ],
      connected(),
    );
  }

  it("sos_grants_created is armed: a pending tone whatever ok says, never success, never failure", () => {
    expect(isPendingStatus("sos_grants_created")).toBe(true);
    expect(toolResultTone("sos_grants_created", false)).toBe("pending");
    expect(toolResultTone("sos_grants_created", true)).toBe("pending");
    expect(isSuccessStatus("sos_grants_created")).toBe(false);
    expect(NOT_SUCCESS_STATUSES.has("sos_grants_created")).toBe(true);
    // The pending tone is scoped to the armed alert; the other interim
    // statuses keep their pinned failure tone.
    expect(isPendingStatus("grant_created")).toBe(false);
    expect(isPendingStatus("check_in_created")).toBe(false);
    expect(isPendingStatus("position_publish_pending")).toBe(false);
    expect(isPendingStatus("location_updates_pending")).toBe(false);
    expect(toolResultTone("grant_created", true)).toBe("failure");
    expect(toolResultTone("location_updates_pending", true)).toBe("failure");
  });

  it("classifies the delivery, stop and roster statuses: only sos_sent and sos_stopped may succeed", () => {
    expect(toolResultTone("sos_sent", true)).toBe("success");
    expect(toolResultTone("sos_stopped", true)).toBe("success");
    for (const status of [
      "sos_partial",
      "sos_not_sent",
      "sos_unverified",
      "sos_partially_stopped",
      "roster_full",
      "already_active",
      "not_active",
    ]) {
      expect(isNeutralStatus(status), status).toBe(true);
      expect(isSuccessStatus(status), status).toBe(false);
      expect(toolResultTone(status, true), status).toBe("neutral");
    }
    // A refusal keyed on reason_code is still a refusal.
    expect(toolResultTone("rejected", false)).toBe("failure");
  });

  it("an executed resolution that is only armed never sets the success-looking complete phase", () => {
    const card = pendingActionFrame({
      tool: "trigger_save_my_soul",
      gateway_action_id: "location.trigger_sos",
      tier: "tap",
      requires_tap: true,
      receipt_token: "receipt-sos",
      entities: [],
    });
    const base = run(
      [server(card), server({ type: "state", state: "executing" })],
      connected(),
    );
    // No state frame after the resolution: the phase is what the reducer chose.
    const armedOnly = run(
      [
        server({
          type: "pending_action.resolved",
          pending_action_id: card.pending_action_id,
          status: "executed",
          result_public: ARMED,
        }),
      ],
      base,
    );
    expect(armedOnly.pendingAction?.resolvedStatus).toBe("executed");
    expect(armedOnly.phase).toBe("listening");
    expect(SUCCESS_LOOKING.has(armedOnly.phase)).toBe(false);
    expect(selectSuccessReceipt(armedOnly)).toBeNull();

    // A paused device stays paused; an ordinary executed card still completes.
    const paused = run([{ type: "paused" }], base);
    expect(
      run(
        [
          server({
            type: "pending_action.resolved",
            pending_action_id: card.pending_action_id,
            status: "executed",
            result_public: ARMED,
          }),
        ],
        paused,
      ).phase,
    ).toBe("paused");
    expect(
      run(
        [
          server({
            type: "pending_action.resolved",
            pending_action_id: card.pending_action_id,
            status: "executed",
            result_public: { status: "sos_sent", delivered: ["Priya"] },
          }),
        ],
        base,
      ).phase,
    ).toBe("complete");
  });

  it("a socket close while the alert is still armed settles it as unconfirmed, never sent", () => {
    const state = armed();
    const id = state.pendingAction!.pending_action_id;
    const withStep = run(
      [
        server({
          type: "client_step.request",
          step_id: "step-sos",
          kind: "publish_location_envelopes",
          payload: { purpose: "sos", sos: true, grant_ids: ["grant_SECRET_a"] },
          timeout_s: 60,
        }),
      ],
      state,
    );
    expect(withStep.clientStep?.stepId).toBe("step-sos");

    for (const close of [
      { code: CLOSE_CODES.ended, reason: localCloseReason("stop") },
      { code: CLOSE_CODES.idle, reason: "idle" },
      { code: CLOSE_CODES.providerUnavailable, reason: "" },
    ]) {
      const closed = run([{ type: "closed", ...close, now: NOW }], withStep);
      const card = closed.pendingAction!;
      expect(card.pending_action_id, close.reason).toBe(id);
      expect(card.resolvedStatus).toBe("executed");
      expect(card.resolvedResult).toMatchObject({
        status: "sos_unverified",
        reason_code: SOS_CLOSED_UNVERIFIED_REASON,
        spoken_facts: [SOS_CLOSED_UNVERIFIED_FACT],
        expected_grant_ids: ["grant_SECRET_a"],
        alert_active: true,
      });
      expect(card.result).toBe(card.resolvedResult);
      expect(isPendingStatus(card.resolvedResult?.status)).toBe(false);
      // The timeline entry says the same thing, and it is not a receipt.
      expect(closed.toolTimeline).toHaveLength(1);
      expect(closed.toolTimeline[0]).toMatchObject({
        ok: false,
        result: { status: "sos_unverified", reason_code: SOS_CLOSED_UNVERIFIED_REASON },
      });
      expect(closed.lastResult?.status).toBe("sos_unverified");
      expect(selectSuccessReceipt(closed)).toBeNull();
      expect(closed.clientStep).toBeNull();
      expect(JSON.stringify(closed.pendingAction)).not.toContain("sos_sent");
      expect(JSON.stringify(closed.pendingAction)).not.toContain("sos_not_sent");
    }
  });

  it("a go_away close settles the armed card too, and the reconnected session keeps it", () => {
    const state = run(
      [server({ type: "session.reconnect_required", reason: "go_away" })],
      armed(),
    );
    expect(canAutoReconnect(state)).toBe(true);
    const closed = run(
      [{ type: "closed", code: 1001, reason: "go_away", now: NOW }],
      state,
    );
    expect(closed.phase).toBe("connecting");
    expect(closed.pendingAction?.resolvedResult?.status).toBe("sos_unverified");
    const resumed = run(
      [
        { type: "connecting", conversationId: closed.conversationId! },
        server(readyFrame({ conversation_id: closed.conversationId! })),
      ],
      closed,
    );
    // The card was not re-listed (it resolved server-side): the local
    // unconfirmed receipt stays, and nothing says sending any more.
    expect(resumed.pendingAction?.resolvedResult?.status).toBe("sos_unverified");
    expect(resumed.clientStep).toBeNull();
  });

  it("close leaves everything else alone: settled SOS cards, other cards, no card", () => {
    const sent = run(
      [
        server({
          type: "pending_action.resolved",
          pending_action_id: armed().pendingAction!.pending_action_id,
          status: "executed",
          result_public: { status: "sos_sent", delivered: ["Priya"] },
        }),
        server(
          toolResult({
            call_id: null,
            tool: "report_save_my_soul_delivery",
            status: "sos_sent",
            ok: true,
            result_public: { status: "sos_sent", delivered: ["Priya"] },
          }),
        ),
      ],
      armed(),
    );
    expect(settleArmedSosOnClose(sent)).toBe(sent);
    const closedSent = run(
      [{ type: "closed", code: CLOSE_CODES.ended, reason: "ended", now: NOW }],
      sent,
    );
    expect(closedSent.pendingAction?.resolvedResult?.status).toBe("sos_sent");
    expect(closedSent.toolTimeline[0]?.result?.status).toBe("sos_sent");

    const share = run(
      [
        server(pendingActionFrame()),
        server({
          type: "pending_action.resolved",
          pending_action_id: pendingActionFrame().pending_action_id,
          status: "executed",
          result_public: { status: "share_created" },
        }),
      ],
      connected(),
    );
    expect(settleArmedSosOnClose(share)).toBe(share);
    const bare = connected();
    expect(settleArmedSosOnClose(bare)).toBe(bare);
  });

  it("an armed alert yields no success receipt and one timeline entry", () => {
    const state = armed();
    expect(state.pendingAction?.resolvedStatus).toBe("executed");
    expect(state.pendingAction?.resolvedResult?.status).toBe(
      "sos_grants_created",
    );
    expect(state.pendingAction?.receiptToken).toBeNull();
    expect(selectSuccessReceipt(state)).toBeNull();
    expect(state.toolTimeline).toHaveLength(1);
    expect(state.toolTimeline[0]).toMatchObject({
      callId: null,
      tool: "trigger_save_my_soul",
      ok: false,
      result: { status: "sos_grants_created" },
    });
    expect(state.phase).toBe("listening");
  });

  it("a second pending_action.resolved for the same card replaces the armed result with the verified report", () => {
    const state = armed();
    const id = state.pendingAction!.pending_action_id;
    const report = {
      status: "sos_partial",
      spoken_facts: ["Your position reached Priya."],
      delivered: ["Priya"],
      not_alerted: ["Rahul"],
      delivered_grant_ids: ["grant_SECRET_a"],
      not_alerted_grant_ids: ["grant_SECRET_b"],
      alert_active: true,
      device_step: { status: "ok", late: false },
    };
    const settled = run(
      [
        server({
          type: "pending_action.resolved",
          pending_action_id: id,
          status: "executed",
          result_public: report,
        }),
      ],
      state,
    );
    expect(settled.pendingAction?.pending_action_id).toBe(id);
    expect(settled.pendingAction?.resolvedStatus).toBe("executed");
    expect(settled.pendingAction?.resolvedResult).toBe(report);
    expect(settled.pendingAction?.result).toBe(report);
    // Partly sent is truthful but not an achievement.
    expect(selectSuccessReceipt(settled)).toBeNull();

    const failed = run(
      [
        server({
          type: "pending_action.resolved",
          pending_action_id: id,
          status: "failed",
          result_public: { status: "sos_not_sent", not_alerted: ["Priya"] },
        }),
      ],
      state,
    );
    expect(failed.pendingAction?.resolvedStatus).toBe("failed");
    expect(failed.pendingAction?.resolvedResult?.status).toBe("sos_not_sent");
    expect(failed.pendingAction?.status).toBe("failed");
    expect(selectSuccessReceipt(failed)).toBeNull();
    expect(failed.phase).toBe("listening");

    const unverified = run(
      [
        server({
          type: "pending_action.resolved",
          pending_action_id: id,
          status: "failed",
          result_public: { status: "sos_unverified" },
        }),
      ],
      state,
    );
    expect(selectSuccessReceipt(unverified)).toBeNull();
  });

  it("the delivery report (no call id) replaces the armed timeline item so the panel shows one SOS card", () => {
    const state = armed();
    const id = state.pendingAction!.pending_action_id;
    const report = {
      status: "sos_sent",
      spoken_facts: ["Your position reached Priya."],
      delivered: ["Priya"],
      not_alerted: [],
      delivered_grant_ids: ["grant_SECRET_a"],
      alert_active: true,
    };
    const settled = run(
      [
        server({
          type: "pending_action.resolved",
          pending_action_id: id,
          status: "executed",
          result_public: report,
        }),
        server(
          toolResult({
            call_id: null,
            tool: "report_save_my_soul_delivery",
            status: "sos_sent",
            ok: true,
            result_public: { ...report },
          }),
        ),
        server({ type: "state", state: "complete" }),
      ],
      state,
    );
    expect(settled.toolTimeline).toHaveLength(1);
    expect(settled.toolTimeline[0]).toMatchObject({
      callId: null,
      tool: "report_save_my_soul_delivery",
      ok: true,
      result: { status: "sos_sent" },
    });
    expect(settled.lastResult?.status).toBe("sos_sent");
    // Only the server's verified "sent" is a receipt, and it comes from the
    // card's resolution.
    expect(selectSuccessReceipt(settled)).toMatchObject({
      source: "pending_action.resolved",
      tool: "trigger_save_my_soul",
      status: "sos_sent",
    });

    // A settled entry is final: a later unrelated result is a new row.
    const later = run(
      [
        server(
          toolResult({
            call_id: "c-later",
            tool: "list_people",
            status: "no_connections",
            ok: true,
            result_public: { status: "no_connections" },
          }),
        ),
      ],
      settled,
    );
    expect(later.toolTimeline).toHaveLength(2);
  });

  it("a not-sent or unverified report never becomes a receipt even with ok mis-flagged", () => {
    for (const status of ["sos_not_sent", "sos_unverified", "sos_partial"]) {
      const settled = run(
        [
          server(
            toolResult({
              call_id: null,
              tool: "report_save_my_soul_delivery",
              status,
              ok: true,
              result_public: { status },
            }),
          ),
        ],
        armed(),
      );
      expect(settled.toolTimeline, status).toHaveLength(1);
      expect(settled.toolTimeline[0]?.result?.status, status).toBe(status);
      expect(selectSuccessReceipt(settled), status).toBeNull();
    }
  });

  it("the report only replaces an armed entry; without one it is its own row", () => {
    const state = run(
      [
        server(
          toolResult({
            call_id: null,
            tool: "report_save_my_soul_delivery",
            status: "sos_not_sent",
            ok: false,
            result_public: { status: "sos_not_sent" },
          }),
        ),
      ],
      connected(),
    );
    expect(state.toolTimeline).toHaveLength(1);
    expect(state.toolTimeline[0]?.tool).toBe("report_save_my_soul_delivery");
  });
});
