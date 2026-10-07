import { describe, expect, it } from "vitest";

import {
  CLOSE_CODES,
  NOT_SUCCESS_STATUSES,
  type ServerFrame,
  type ToolResultFrame,
  type ToolResultPublic,
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

describe("turn ownership", () => {
  it("ignores navigation settlement for another call or an older input", () => {
    const state = run([
      server({ type: "transcript.input", turn_id: "old", text: "Open profile", final: true }),
      server({ type: "tool.started", call_id: "profile", tool: "open_screen", args_public: {}, turn_id: "old" }),
      server({ type: "transcript.input", turn_id: "new", text: "List connections", final: true }),
    ], connected());
    expect(reduceVoiceSession(state, { type: "navigation_settled", callId: "profile", turnId: "old", status: "opened" })).toBe(state);
    expect(reduceVoiceSession(state, { type: "navigation_settled", callId: "other", turnId: "new", status: "failed" })).toBe(state);
  });

  const input = (turn_id: string, text: string): ServerFrame => ({
    type: "transcript.input", turn_id, text, final: true,
  });
  const output = (turn_id: string, text: string): ServerFrame => ({
    type: "transcript.output", turn_id, text, final: true,
  });

  it("clears a completed input without letting its late frames replace the next answer", () => {
    let state = run([server(input("a", "first")), server(output("a", "first answer"))], connected());
    state = run([server(input("b", "second"))], state);
    expect(state.activeInputTurnId).toBe("b");
    expect(state.fencedTurnIds).toContain("a");

    state = run([
      server({ type: "turn", state: "model_end", turn_id: "a" }),
      server(output("a", "late first answer")),
      server(toolResult({ turn_id: "a", result_public: { status: "ok", echoed: "old" } })),
    ], state);
    expect(state.activeInputTurnId).toBe("b");
    expect(state.lastResult).toBeNull();
    expect(state.transcript.some((item) => item.text.includes("late first answer"))).toBe(false);

    state = run([
      server({ type: "turn", state: "model_end", turn_id: "b" }),
      server({ type: "state", state: "listening" }),
      server(output("c", "autonomous update")),
    ], state);
    expect(state.activeInputTurnId).toBeNull();
    expect(state.transcript.at(-1)?.text).toBe("autonomous update");
    expect(state.fencedTurnIds).toContain("a");
  });

  it("uses the call ledger for an untagged deferred result, and fails closed when origin is unknown", () => {
    const state = run([
      server(input("a", "first")),
      server({ type: "tool.started", call_id: "call-a", tool: "echo", args_public: {}, turn_id: "a" }),
      server(input("b", "second")),
      server(toolResult({ call_id: "call-a", turn_id: undefined, result_public: { status: "ok", echoed: "old" } })),
      server(toolResult({ call_id: "unknown", turn_id: undefined, result_public: { status: "ok", echoed: "unknown" } })),
    ], connected());
    expect(state.activeInputTurnId).toBe("b");
    expect(state.lastResult).toBeNull();
    expect(state.toolTimeline.find((item) => item.callId === "call-a")?.turnId).toBe("a");
    expect(state.toolTimeline.some((item) => item.result?.echoed === "old")).toBe(true);
  });

  it("rejects fenced narration origins but accepts new autonomous audio after completion", () => {
    const state = run([
      server(input("a", "first")),
      server(input("b", "second")),
      server({ type: "audio", data: "QUJD", mime_type: "audio/pcm;rate=24000", turn_id: "narration-a", origin_turn_id: "a" }),
      server({ type: "turn", state: "model_end", turn_id: "b" }),
      server({ type: "audio", data: "QUJD", mime_type: "audio/pcm;rate=24000", turn_id: "c", origin_turn_id: "c" }),
    ], connected());
    expect(state.turnId).toBe("c");
    expect(state.activeResponseTurnId).toBe("c");
  });

  it("retires a completed origin before any late audio can reclaim a newer response", () => {
    let state = run([
      server(input("a", "First")),
      server({ type: "turn", state: "model_end", turn_id: "a" }),
      server({ type: "audio", data: "QUJD", mime_type: "audio/pcm;rate=24000", turn_id: "c", origin_turn_id: "c" }),
    ], connected());
    expect(state.fencedTurnIds).toContain("a");
    state = run([
      server({ type: "audio", data: "QUJD", mime_type: "audio/pcm;rate=24000", turn_id: "a", origin_turn_id: "a" }),
      server(output("a", "Late old answer")),
    ], state);
    expect(state.activeResponseTurnId).toBe("c");
    expect(state.transcript.some((item) => item.text === "Late old answer")).toBe(false);
  });

  it("keeps a fresh name answer after a delayed Mail result and speech", () => {
    const state = run([
      server(input("mail-turn", "Is Gmail connected?")),
      server({ type: "tool.started", call_id: "mail-call", tool: "get_mail_access", args_public: {}, turn_id: "mail-turn" }),
      server(input("name-turn", "What is my name?")),
      server(toolResult({ call_id: "mail-call", tool: "get_mail_access", turn_id: "mail-turn", result_public: { status: "connected", account: "mail" } })),
      server({ type: "audio", data: "QUJD", mime_type: "audio/pcm;rate=24000", turn_id: "mail-audio", origin_turn_id: "mail-turn" }),
      server(output("mail-turn", "Your Gmail is connected.")),
      server({ type: "tool.started", call_id: "name-call", tool: "get_profile", args_public: {}, turn_id: "name-turn" }),
      server(toolResult({ call_id: "name-call", tool: "get_profile", turn_id: "name-turn", result_public: { status: "ok", display_name: "Ankit" } })),
      server(output("name-turn", "Your name is Ankit.")),
    ], connected());
    expect(state.lastResult?.display_name).toBe("Ankit");
    expect(state.turnId).toBe("name-turn");
    expect(state.transcript.some((item) => item.text === "Your Gmail is connected.")).toBe(false);
    expect(state.toolTimeline.find((item) => item.callId === "mail-call")?.result?.account).toBe("mail");
  });

  it("fences a restored pending origin after a newer question completes", () => {
    const oldCard = pendingActionFrame({ origin_turn_id: "old-turn" });
    const state = run([
      server(readyFrame({ pending_actions: [oldCard], resumed: true })),
      server(input("new-turn", "New question")),
      server({ type: "turn", state: "model_end", turn_id: "new-turn" }),
      server(toolResult({
        call_id: null,
        pending_action_id: oldCard.pending_action_id,
        turn_id: "old-turn",
        result_public: { status: "deleted", spoken_facts: ["Deleted."] },
      })),
    ], connected());
    expect(state.fencedTurnIds).toContain("old-turn");
    expect(state.activeInputTurnId).toBeNull();
    expect(state.lastResult).toBeNull();
    expect(state.pendingAction?.pending_action_id).toBe(oldCard.pending_action_id);
  });

  it("keeps the card an Edit name sends after One read the old one back", () => {
    // The relay's frames, in order, for a name typed once Live completed the
    // input turn and the read-back: the replacement rides the turn open now.
    const circle = { tool: "create_circle", gateway_action_id: "location.create_circle", entities: [], receipt_token: undefined };
    const oldCard = pendingActionFrame({ ...circle, pending_action_id: "11111111-0000-4000-8000-0000000000e1", turn_id: "input" });
    const newCard = pendingActionFrame({ ...circle, pending_action_id: "11111111-0000-4000-8000-0000000000e2", turn_id: "open" });
    let state = run([
      server(input("input", "Create Hush Garage V4")),
      server(oldCard),
      server({ type: "state", state: "confirming", turn_id: "input" }),
      server({ type: "turn", state: "model_end", turn_id: "input" }),
      server(output("read-back", "Should I create Hush Garage V4?")),
      server({ type: "turn", state: "model_end", turn_id: "read-back" }),
      server({ type: "state", state: "listening" }),
      server({ type: "pending_action.resolved", pending_action_id: oldCard.pending_action_id, status: "cancelled", result_public: null }),
      server(newCard),
      server({ type: "state", state: "confirming", turn_id: "open" }),
      server({ type: "name_edit.result", operation_id: "op-edit-1", status: "accepted", reason_code: null, message: null, pending_action_id: newCard.pending_action_id }),
    ], connected());
    expect(state.pendingAction?.pending_action_id).toBe(newCard.pending_action_id);
    expect(hasOpenPendingAction(state)).toBe(true);
    expect(state.phase).toBe("confirming");

    // One asks about it and its turn ends: the card stays, and its own
    // resolution still lands.
    state = run([
      server(output("open", "Should I create HUSSH GARAGE V04?")),
      server({ type: "turn", state: "model_end", turn_id: "open" }),
      server({ type: "state", state: "listening" }),
    ], state);
    expect(state.pendingAction?.pending_action_id).toBe(newCard.pending_action_id);
    expect(hasOpenPendingAction(state)).toBe(true);
    state = run([
      server({ type: "pending_action.resolved", pending_action_id: newCard.pending_action_id, status: "executed", result_public: { status: "created" } }),
    ], state);
    expect(state.pendingAction?.resolvedStatus).toBe("executed");
  });

  it("does not give an unowned result the answer slot after completion", () => {
    const state = run([
      server(input("a", "First question")),
      server({ type: "turn", turn_id: "a", state: "model_end" }),
      server(toolResult({
        call_id: null,
        turn_id: undefined,
        result_public: { status: "ok", echoed: "unowned" },
      })),
    ], connected());
    expect(state.lastResult).toBeNull();
  });
});

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

  it("reports an abnormal network close as recoverable", () => {
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
    ]) {
      const state = run(
        [{ type: "closed", code, reason: "", now: NOW }],
        connected(),
      );
      expect(state.error?.recoverable).toBe(false);
    }
    const networkLost = run(
      [{ type: "closed", code: 1006, reason: "", now: NOW }],
      connected(),
    );
    expect(networkLost.error?.code).toBe("network_lost");
    expect(networkLost.error?.recoverable).toBe(true);
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

describe("reduceVoiceSession: answer ownership", () => {
  it("keeps late read receipts in the timeline without replacing a newer answer", () => {
    const afterNewQuestion = run(
      [
        server({ type: "transcript.input", text: "Is Mail connected?", final: true, turn_id: "mail" }),
        server(toolResult({ call_id: "mail-call", turn_id: "mail", result_public: { status: "mail_ready" } })),
        server({ type: "transcript.input", text: "What is my name?", final: true, turn_id: "profile" }),
      ],
      connected(),
    );
    expect(afterNewQuestion.lastResult).toBeNull();

    const settled = run(
      [
        server(toolResult({ call_id: "late-mail", turn_id: "mail", result_public: { status: "mail_ready" } })),
        server(toolResult({ call_id: "profile-call", turn_id: "profile", result_public: { status: "profile_ready" } })),
      ],
      afterNewQuestion,
    );
    expect(settled.lastResult?.status).toBe("profile_ready");
    expect(settled.toolTimeline.map((item) => item.callId)).toEqual([
      "mail-call", "late-mail", "profile-call",
    ]);
  });

  it("settles an older confirmed action by exact pending ID without showing it as the new answer", () => {
    const pending = pendingActionFrame();
    const state = run(
      [
        server({ type: "transcript.input", text: "Share", final: true, turn_id: "old" }),
        server(pending),
        server({ type: "transcript.input", text: "What is my name?", final: true, turn_id: "new" }),
        server(toolResult({
          call_id: "old-action",
          turn_id: "old",
          pending_action_id: pending.pending_action_id,
          result_public: { status: "share_created" },
        })),
      ],
      connected(),
    );
    expect(state.pendingAction?.resolvedStatus).toBe("executed");
    expect(state.lastResult).toBeNull();
  });

  // Rows the server offered under a revision: the list "the second one" and
  // "reply to it" are spoken about.
  const OFFERED_MAIL: ToolResultPublic = {
    status: "ok",
    spoken_facts: ["I read your 2 newest messages."],
    items: [
      { source_ref: "mail:1", subject: "Q3 deck", sender: "Priya" },
      { source_ref: "mail:2", subject: "March invoice", sender: "Acme" },
    ],
    coverage: { unit: "messages", returned: 2, scope: "newest" },
    offer_revision: 7,
    conversation_id: "11111111-2222-4333-8444-555555555555",
  };

  it("keeps an offered mail list on screen across the next question until that question answers", () => {
    // Regression: the new input cleared the slot, so a spoken "open the second
    // one" arrived with no list left on screen to open.
    const read = run(
      [
        server({ type: "transcript.input", text: "What's in my inbox?", final: true, turn_id: "read" }),
        server(toolResult({ call_id: "read-call", tool: "read_mail", turn_id: "read", status: "ok", result_public: OFFERED_MAIL })),
      ],
      connected(),
    );
    expect(read.lastResult).toBe(OFFERED_MAIL);

    const asked = run(
      [server({ type: "transcript.input", text: "Open the second one", final: true, turn_id: "open" })],
      read,
    );
    expect(asked.activeInputTurnId).toBe("open");
    expect(asked.lastResult).toBe(OFFERED_MAIL);

    // Opening dispatches; it does not answer. It joins the timeline but never
    // takes the slot from the list it opens a row of.
    const dispatched = run(
      [
        server(toolResult({
          call_id: "open-call",
          tool: "open_mail",
          turn_id: "open",
          status: "mail_open_dispatched",
          result_public: {
            status: "mail_open_dispatched",
            spoken_facts: ["Opening it."],
            ordinal: 2,
            offer_revision: 7,
            conversation_id: "11111111-2222-4333-8444-555555555555",
          },
        })),
      ],
      asked,
    );
    expect(dispatched.toolTimeline.at(-1)?.result?.status).toBe("mail_open_dispatched");
    expect(dispatched.lastResult).toBe(OFFERED_MAIL);

    // Still the list while the next question is being answered...
    const next = run(
      [
        server({ type: "turn", state: "model_end", turn_id: "open" }),
        server({ type: "transcript.input", text: "What is my name?", final: true, turn_id: "name" }),
      ],
      dispatched,
    );
    expect(next.activeInputTurnId).toBe("name");
    expect(next.lastResult).toBe(OFFERED_MAIL);

    // ...until that question's own answer takes the slot.
    const answered = run(
      [server(toolResult({ call_id: "name-call", tool: "get_profile", turn_id: "name", status: "ok", result_public: { status: "ok", display_name: "Ankit" } }))],
      next,
    );
    expect(answered.lastResult?.display_name).toBe("Ankit");
  });

  it("keeps a drafts list or a scheduled list on screen while a position in it is acted on", () => {
    const conversation = "11111111-2222-4333-8444-555555555555";
    const drafts: ToolResultPublic = {
      status: "ok",
      spoken_facts: ["You have 2 drafts."],
      items: [
        { source_ref: "draft:1", to: "Priya", subject: "Diwali plans" },
        { source_ref: "draft:2", to: "Arjun", subject: "Rent" },
      ],
      coverage: { returned: 2, has_more: false },
      offer_revision: 8,
      conversation_id: conversation,
    };
    const scheduled: ToolResultPublic = {
      status: "ok",
      spoken_facts: ["You have 1 scheduled email."],
      items: [
        {
          source_ref: "scheduled:1",
          to: "Priya",
          subject: "Diwali plans",
          send_at: "2026-10-06T03:30:00+00:00",
          send_at_label: "Tomorrow, 9:00 AM IST",
        },
      ],
      coverage: { returned: 1, next_send_at: "2026-10-06T03:30:00+00:00" },
      offer_revision: 9,
      conversation_id: conversation,
    };
    for (const [tool, result] of [
      ["list_drafts", drafts],
      ["list_scheduled_mail", scheduled],
    ] as const) {
      const shown = run(
        [
          server({ type: "transcript.input", text: "Show them", final: true, turn_id: "a" }),
          server(toolResult({ call_id: "a-call", tool, turn_id: "a", status: "ok", result_public: result })),
          server({ type: "transcript.input", text: "The second one", final: true, turn_id: "b" }),
        ],
        connected(),
      );
      expect(shown.lastResult, tool).toBe(result);
    }

    // Opening a draft dispatches; like a mail open it never takes the slot.
    const dispatched = run(
      [
        server({ type: "transcript.input", text: "Show my drafts", final: true, turn_id: "d" }),
        server(toolResult({ call_id: "d-call", tool: "list_drafts", turn_id: "d", status: "ok", result_public: drafts })),
        server({ type: "transcript.input", text: "Open the second one", final: true, turn_id: "o" }),
        server(toolResult({
          call_id: "o-call",
          tool: "open_draft",
          turn_id: "o",
          status: "draft_open_dispatched",
          result_public: {
            status: "draft_open_dispatched",
            spoken_facts: ["Opening it."],
            ordinal: 2,
            offer_revision: 8,
            conversation_id: conversation,
          },
        })),
      ],
      connected(),
    );
    expect(dispatched.toolTimeline.at(-1)?.result?.status).toBe("draft_open_dispatched");
    expect(dispatched.lastResult).toBe(drafts);
  });

  it("keeps the list on screen while a send or cancel card about a position in it waits, then yields to the result", () => {
    // Regression: the confirmation result took the answer slot, so the drafts
    // list vanished the moment the send card appeared and "send draft 2" was
    // approved with nothing on screen saying which draft 2 was.
    const conversation = "11111111-2222-4333-8444-555555555555";
    const drafts: ToolResultPublic = {
      status: "ok",
      spoken_facts: ["You have 2 drafts."],
      items: [
        { source_ref: "draft:1", to: "Priya", subject: "Diwali plans" },
        { source_ref: "draft:2", to: "Arjun", subject: "Rent" },
      ],
      coverage: { returned: 2, has_more: false },
      offer_revision: 8,
      conversation_id: conversation,
    };
    const scheduled: ToolResultPublic = {
      status: "ok",
      spoken_facts: ["You have 1 scheduled email."],
      items: [
        {
          source_ref: "scheduled:1",
          to: "Priya",
          subject: "Diwali plans",
          send_at: "2026-10-06T03:30:00+00:00",
          send_at_label: "Tomorrow, 9:00 AM IST",
        },
      ],
      coverage: { returned: 1, next_send_at: "2026-10-06T03:30:00+00:00" },
      offer_revision: 9,
      conversation_id: conversation,
    };
    const cases = [
      ["list_drafts", drafts, "send_draft", "draft_sent"],
      ["list_scheduled_mail", scheduled, "cancel_scheduled_mail", "cancelled"],
    ] as const;
    for (const [listTool, list, cardTool, finalStatus] of cases) {
      const pendingId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const card = run(
        [
          server({ type: "transcript.input", text: "Show them", final: true, turn_id: "a" }),
          server(toolResult({ call_id: "a-call", tool: listTool, turn_id: "a", status: "ok", result_public: list })),
          server({ type: "turn", state: "model_end", turn_id: "a" }),
          server({ type: "transcript.input", text: "The second one", final: true, turn_id: "b" }),
          server(
            pendingActionFrame({
              pending_action_id: pendingId,
              tool: cardTool,
              gateway_action_id: "email.chat.turn",
              summary: "send draft 2 in your list now",
              args: { ordinal: 2 },
              entities: [],
              receipt_token: null,
              turn_id: "b",
            }),
          ),
          server(
            toolResult({
              call_id: "b-call",
              tool: cardTool,
              turn_id: "b",
              status: "confirmation_required",
              ok: false,
              result_public: {
                status: "confirmation_required",
                needs: "confirmation",
                pending_action_id: pendingId,
                spoken_facts: ["Send draft 2 in your list now?"],
              },
            }),
          ),
        ],
        connected(),
      );
      expect(card.pendingAction?.resolvedStatus, cardTool).toBeNull();
      // The card waits with the list it is about still in the answer slot.
      expect(card.lastResult, cardTool).toBe(list);

      const yes = run(
        [
          server({ type: "turn", state: "model_end", turn_id: "b" }),
          server({ type: "transcript.input", text: "Yes", final: true, turn_id: "c" }),
        ],
        card,
      );
      expect(yes.lastResult, cardTool).toBe(list);

      // The resolution is a real result: the list gives way to it.
      const finalResult = { status: finalStatus, spoken_facts: ["Done."] };
      const resolved = run(
        [
          server({
            type: "pending_action.resolved",
            pending_action_id: pendingId,
            status: "executed",
            result_public: finalResult,
          }),
        ],
        yes,
      );
      expect(resolved.lastResult, cardTool).not.toBe(list);
      expect(resolved.pendingAction?.resolvedResult, cardTool).toEqual(finalResult);
      const answered = run(
        [server(toolResult({ call_id: "c-call", tool: cardTool, turn_id: "c", status: finalStatus, result_public: finalResult }))],
        resolved,
      );
      expect(answered.lastResult, cardTool).toEqual(finalResult);
    }

    // Negative control: a card over a result with no offered rows still takes
    // the slot, exactly as before.
    const people: ToolResultPublic = {
      status: "ok",
      spoken_facts: ["You have 1 connection."],
      connected: [{ user_id: "u-1", display_name: "Priya" }],
    };
    const confirmation: ToolResultPublic = {
      status: "confirmation_required",
      needs: "confirmation",
      spoken_facts: ["Share with Priya?"],
    };
    const replaced = run(
      [
        server({ type: "transcript.input", text: "Who do I know?", final: true, turn_id: "p" }),
        server(toolResult({ call_id: "p-call", tool: "list_people", turn_id: "p", status: "ok", result_public: people })),
        server(toolResult({ call_id: "s-call", tool: "share_with", turn_id: "p", status: "confirmation_required", ok: false, result_public: confirmation })),
      ],
      connected(),
    );
    expect(replaced.lastResult).toBe(confirmation);
  });

  it("an older confirmation cannot clear a newer offered answer, even after a card refresh", () => {
    for (const tool of ["read_mail", "list_drafts", "list_scheduled_mail"]) {
      const card = pendingActionFrame({ origin_turn_id: "old", turn_id: "old" });
      const newerList = { ...OFFERED_MAIL, offer_revision: 8 };
      const receipt = { status: "deleted", spoken_facts: ["Deleted."] };
      const shown = run([
        server({ type: "transcript.input", turn_id: "old", text: "Delete the first item", final: true }),
        server(toolResult({ call_id: "old-list", tool, turn_id: "old", result_public: OFFERED_MAIL })),
        server(card),
        server({ type: "transcript.input", turn_id: "new", text: "Show the latest list", final: true }),
        server(toolResult({ call_id: "new-list", tool, turn_id: "new", result_public: newerList })),
        server({ type: "turn", turn_id: "new", state: "model_end" }),
      ], connected());

      for (const refreshCard of [false, true]) {
        const refreshed = refreshCard
          ? run([server({ ...card, turn_id: undefined })], shown)
          : shown;
        const resolved = run([server({
          type: "pending_action.resolved",
          pending_action_id: card.pending_action_id,
          status: "executed",
          result_public: receipt,
        })], refreshed);
        expect(resolved.lastResult, tool).toBe(newerList);
        expect(resolved.pendingAction?.resolvedResult).toBe(receipt);
        const late = run([server(toolResult({
          call_id: "old-action", tool: card.tool, turn_id: "old",
          pending_action_id: card.pending_action_id, result_public: receipt,
        }))], resolved);
        expect(late.lastResult, tool).toBe(newerList);
      }
    }
  });

  it("still gives the slot to a new question when the result has no offered rows to act on", () => {
    const { offer_revision: _revision, ...unbound } = OFFERED_MAIL;
    void _revision;
    const cases: Array<[string, string, ToolResultPublic]> = [
      [
        "people",
        "list_people",
        { status: "ok", spoken_facts: ["You have 1 connection."], connected: [{ user_id: "u-1", display_name: "Priya" }] },
      ],
      ["an empty read", "read_mail", { ...OFFERED_MAIL, items: [] }],
      ["rows with no offer to resolve a position against", "read_mail", unbound],
    ];
    for (const [label, tool, result] of cases) {
      const shown = run(
        [
          server({ type: "transcript.input", text: "First", final: true, turn_id: "a" }),
          server(toolResult({ call_id: "a-call", tool, turn_id: "a", status: "ok", result_public: result })),
        ],
        connected(),
      );
      expect(shown.lastResult, label).toBe(result);
      const asked = run(
        [server({ type: "transcript.input", text: "Second", final: true, turn_id: "b" })],
        shown,
      );
      expect(asked.lastResult, label).toBeNull();
    }
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

  // Rendering is idempotent per identity (role + turn). Regression: a
  // restated final doubled "Shall I create HUSSH GARAGE V04?" in one line.
  const lines = (state: VoiceSessionState) =>
    state.transcript.map((item) => [item.role, item.text]);
  const out = (text: string, final: boolean, turn_id = "t1") =>
    server({ type: "transcript.output", text, final, turn_id });
  const said = (text: string, final: boolean, turn_id = "t1") =>
    server({ type: "transcript.input", text, final, turn_id });

  it("a re-sent final for the same role and turn shows once", () => {
    const state = run(
      [out("Shall I create it?", true), out("Shall I create it?", true)],
      connected(),
    );
    expect(lines(state)).toEqual([["one", "Shall I create it?"]]);
  });

  it("negative control: the same sentence in a later turn still shows", () => {
    const state = run(
      [
        said("yes", true, "t1"),
        out("Done.", true, "t1"),
        server({ type: "turn", state: "model_end", turn_id: "t1" }),
        said("yes", true, "t2"),
        out("Done.", true, "t2"),
      ],
      connected(),
    );
    expect(lines(state)).toEqual([
      ["you", "yes"],
      ["one", "Done."],
      ["you", "yes"],
      ["one", "Done."],
    ]);
  });

  it("negative control: post-final speech in the same turn is its own line", () => {
    const state = run(
      [out("Creating it.", true), out(" Done.", true)],
      connected(),
    );
    expect(lines(state)).toEqual([
      ["one", "Creating it."],
      ["one", " Done."],
    ]);
  });

  it("a final restating the line without a byte prefix replaces it", () => {
    const state = run(
      [
        out(" Shall I create", false),
        out(" HUSSH GARAGE V04?", false),
        out("Shall I create HUSSH GARAGE V04?", true),
      ],
      connected(),
    );
    expect(lines(state)).toEqual([["one", "Shall I create HUSSH GARAGE V04?"]]);
    expect(state.transcript[0]?.final).toBe(true);
  });

  it("a leading-space final restating accumulated legacy chunks shows once", () => {
    const state = run(
      [
        out("Shall I create", false),
        out(" HUSSH GARAGE V04?", false),
        out(" Shall I create HUSSH GARAGE V04?", true),
        out(" Shall I create HUSSH GARAGE V04?", true),
      ],
      connected(),
    );
    expect(lines(state)).toEqual([["one", " Shall I create HUSSH GARAGE V04?"]]);
    expect(state.transcript[0]?.final).toBe(true);
  });

  it("a leading-space final can restate the same raw legacy line", () => {
    const state = run(
      [out(" Shall I create it?", false), out(" Shall I create it?", true)],
      connected(),
    );
    expect(lines(state)).toEqual([["one", " Shall I create it?"]]);
  });

  it("spelled chunks accumulate; a repeated letter is not a restatement", () => {
    const spelled = run(
      [
        ...["H", "U", "S", "S", "H"].map((letter) => said(letter, false)),
        said("HUSSH", true),
      ],
      connected(),
    );
    expect(lines(spelled)).toEqual([["you", "HUSSH"]]);
    const doubled = run([said("S", false), said("S", false)], connected());
    expect(lines(doubled)).toEqual([["you", "SS"]]);
  });

  // Regression: whitespace-normalized prefix matching let a chunk that
  // begins with a space replace the row, dropping what was already heard.
  it("a chunk that begins with a space continues the row, never replaces it", () => {
    const spelled = run([said("S", false), said(" S", true)], connected());
    expect(lines(spelled)).toEqual([["you", "S S"]]);
    const named = run([said("H", false), said(" Hussh garage", false)], connected());
    expect(lines(named)).toEqual([["you", "H Hussh garage"]]);
    const settled = run(
      [out("Creating it.", true), out(" Creating it. Done.", true)],
      connected(),
    );
    expect(lines(settled)).toEqual([
      ["one", "Creating it."],
      ["one", " Creating it. Done."],
    ]);
  });

  it("row ids stay unique once the 200-row cap is reached", () => {
    const fill = Array.from({ length: 200 }, (_, index) =>
      out(`line ${index}`, true, `f${index}`),
    );
    const state = run(
      [...fill, out("Creating it.", true, "tx"), out(" Done.", true, "tx")],
      connected(),
    );
    expect(state.transcript).toHaveLength(200);
    const ids = state.transcript.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Frames copied verbatim from the relay (test_relay_protocol.py) for two
  // provider shapes behind the UAT doubled lines (2026-10-06): cumulative
  // hypotheses (B) and a finished chunk restating the line with a leading
  // space (F). The relay merges the chunks; the reducer applies its frames.
  it("relay frames for cumulative hypotheses and a restated final show one line each", () => {
    const hypotheses = run(
      [
        server({ type: "transcript.input", text: "Hello", final: false, turn_id: "fffcd9870ab1", segment_id: "ed774565d20f", seq: 1, kind: "cumulative" }),
        server({ type: "transcript.input", text: "Hello there", final: false, turn_id: "fffcd9870ab1", segment_id: "ed774565d20f", seq: 2, kind: "cumulative" }),
        server({ type: "transcript.input", text: "Hello there", final: true, turn_id: "fffcd9870ab1", segment_id: "ed774565d20f", seq: 3, kind: "final" }),
      ],
      connected(),
    );
    expect(lines(hypotheses)).toEqual([["you", "Hello there"]]);
    const restated = run(
      [
        server({ type: "transcript.input", text: "Create it", final: true, turn_id: "221ceb27e9f1", segment_id: "69ecdea15ba6", seq: 1, kind: "final" }),
        server({ type: "transcript.output", text: "Shall I", final: false, turn_id: "221ceb27e9f1", segment_id: "a1a86d74bbfb", seq: 1, kind: "cumulative" }),
        server({ type: "transcript.output", text: "Shall I create it?", final: false, turn_id: "221ceb27e9f1", segment_id: "a1a86d74bbfb", seq: 2, kind: "cumulative" }),
        server({ type: "transcript.output", text: "Shall I create it?", final: true, turn_id: "221ceb27e9f1", segment_id: "a1a86d74bbfb", seq: 3, kind: "final" }),
        server({ type: "turn", state: "model_end", turn_id: "221ceb27e9f1" }),
      ],
      connected(),
    );
    expect(lines(restated)).toEqual([
      ["you", "Create it"],
      ["one", "Shall I create it?"],
    ]);
  });

  // Contract only: the frames below are hand-built to pin how the reducer
  // applies segment_id/seq/kind (partial appends, cumulative replaces, final
  // replaces and freezes, a seq at or below the row's last is ignored). They
  // are not what the relay emits for any provider sequence; the relay's own
  // merge is tested in test_relay_protocol.py.
  const seg = (
    role: "you" | "one",
    text: string,
    kind: "partial" | "cumulative" | "final",
    seq: number,
    segment_id = "s1",
    turn_id = "t1",
  ) =>
    server({
      type: role === "you" ? "transcript.input" : "transcript.output",
      text,
      final: kind === "final",
      turn_id,
      segment_id,
      seq,
      kind,
    });

  it("contract only: a cumulative frame equal to its row, then its final, shows once", () => {
    const hearing = run(
      [seg("you", "Hello", "cumulative", 1), seg("you", "Hello", "cumulative", 2)],
      connected(),
    );
    expect(lines(hearing)).toEqual([["you", "Hello"]]);
    const settled = run([seg("you", "Hello", "final", 3)], hearing);
    expect(lines(settled)).toEqual([["you", "Hello"]]);
    expect(settled.transcript[0]?.final).toBe(true);
  });

  it("contract only: a leading-space cumulative line and its final stay one row", () => {
    const state = run(
      [
        seg("one", " Shall I", "cumulative", 1),
        seg("one", " Shall I create it?", "cumulative", 2),
        seg("one", " Shall I create it?", "final", 3),
      ],
      connected(),
    );
    expect(lines(state)).toEqual([["one", " Shall I create it?"]]);
  });

  it("contract only: spelled letters keep the repeated S", () => {
    const deltas = run(
      ["H", "U", "S", "S", "H"].map((letter, index) =>
        seg("you", letter, "partial", index + 1),
      ),
      connected(),
    );
    expect(lines(deltas)).toEqual([["you", "HUSSH"]]);
    const whole = run(
      [seg("you", "H U S S", "cumulative", 1), seg("you", "H U S S H", "final", 2)],
      connected(),
    );
    expect(lines(whole)).toEqual([["you", "H U S S H"]]);
  });

  it("contract only: a frame applied twice at the same seq changes its row once", () => {
    const state = run(
      [
        seg("you", "Hel", "partial", 1),
        seg("you", "lo", "partial", 2),
        seg("you", "lo", "partial", 2),
      ],
      connected(),
    );
    expect(lines(state)).toEqual([["you", "Hello"]]);
  });

  it("contract only: a frame older than the row's last seq is ignored", () => {
    const state = run(
      [seg("you", "Hello there", "cumulative", 3), seg("you", "Hello", "cumulative", 2)],
      connected(),
    );
    expect(lines(state)).toEqual([["you", "Hello there"]]);
  });

  it("contract only: a final freezes its row and a new segment is a new row", () => {
    const state = run(
      [
        seg("one", "Creating it.", "final", 1),
        seg("one", "Creating it. Again", "cumulative", 2),
        seg("one", "Done.", "cumulative", 1, "s2"),
      ],
      connected(),
    );
    expect(lines(state)).toEqual([
      ["one", "Creating it."],
      ["one", "Done."],
    ]);
    expect(state.transcript.map((item) => item.id)).toEqual(["one:s1", "one:s2"]);
  });

  it("negative control: a frame missing any contract field takes the legacy merge", () => {
    const partialFields = (text: string, final: boolean) =>
      server({
        type: "transcript.output",
        text,
        final,
        turn_id: "t1",
        segment_id: "s1",
      });
    const state = run(
      [
        partialFields(" Shall I create", false),
        partialFields(" HUSSH GARAGE V04?", false),
        partialFields("Shall I create HUSSH GARAGE V04?", true),
      ],
      connected(),
    );
    expect(lines(state)).toEqual([["one", "Shall I create HUSSH GARAGE V04?"]]);
    expect(state.transcript[0]?.id).toBe("one:t1:0");
    const doubled = run(
      [
        server({ type: "transcript.input", text: "S", final: false, turn_id: "t1", seq: 1 }),
        server({ type: "transcript.input", text: "S", final: false, turn_id: "t1", seq: 1 }),
      ],
      connected(),
    );
    expect(lines(doubled)).toEqual([["you", "SS"]]);
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
          expect(state.phase).toBe(
            type === "transcript.input" ? "understanding" : "listening",
          );
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

  it("navigation_dispatched reads neutral, not success, not pending; confirmation_waiting is never success", () => {
    expect(toolResultTone("navigation_dispatched", true)).toBe("neutral");
    expect(toolResultTone("navigation_dispatched", false)).toBe("failure");
    // Screens gate success on this set; ui_settled decides the outcome.
    expect(NOT_SUCCESS_STATUSES.has("navigation_dispatched")).toBe(true);
    // Pending would hold the turn on a device step that never comes.
    expect(isPendingStatus("navigation_dispatched")).toBe(false);
    const waiting = run(
      [
        server(
          toolResult({
            tool: "send_message",
            status: "confirmation_waiting",
            result_public: {
              status: "confirmation_waiting",
              spoken_facts: ["That's already waiting for your answer."],
            },
          }),
        ),
      ],
      connected(),
    );
    expect(NOT_SUCCESS_STATUSES.has("confirmation_waiting")).toBe(true);
    expect(toolResultTone("confirmation_waiting", true)).toBe("failure");
    expect(selectSuccessReceipt(waiting)).toBeNull();
  });

  it("pending_action_exists is a refusal: another card is still waiting, nothing ran", () => {
    const blocked = run(
      [
        server(
          toolResult({
            tool: "add_all_connections",
            status: "pending_action_exists",
            result_public: {
              status: "pending_action_exists",
              spoken_facts: ["Answer the card that's already up first."],
            },
          }),
        ),
      ],
      connected(),
    );
    expect(NOT_SUCCESS_STATUSES.has("pending_action_exists")).toBe(true);
    expect(isSuccessStatus("pending_action_exists")).toBe(false);
    expect(toolResultTone("pending_action_exists", true)).not.toBe("success");
    expect(selectSuccessReceipt(blocked)).toBeNull();
  });

  it("mail awaiting review, sending, unconfirmed, or unchanged is never Done", () => {
    // Regression: these resolved `executed` (the cancel ran and answered), and
    // send_unconfirmed / schedule_unconfirmed were not in the shared set, so the
    // panel showed a green Done for a cancel that cancelled nothing.
    for (const status of [
      "send_unconfirmed",
      "schedule_unconfirmed",
      "already_sent",
      "already_sending",
      "not_sent",
      "review_requested",
      "review_pending",
      "needs_input",
      "outcome_unknown",
      "sending",
    ]) {
      expect(NOT_SUCCESS_STATUSES.has(status), status).toBe(true);
      expect(isSuccessStatus(status), status).toBe(false);
      // Review and delivery remain pending; uncertainty is not an achievement.
      const tone = ["review_requested", "review_pending", "sending"].includes(status) ? "pending" : "neutral";
      expect(toolResultTone(status, true), status).toBe(tone);
      expect(toolResultTone(status, false), status).toBe(tone);
      const card = pendingActionFrame({
        pending_action_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        tool: "cancel_scheduled_mail",
      });
      const executed = run(
        [
          server(card),
          server({
            type: "pending_action.resolved",
            pending_action_id: card.pending_action_id,
            status: "executed",
            result_public: { status, spoken_facts: ["Nothing to cancel."] },
          }),
        ],
        connected(),
      );
      expect(selectSuccessReceipt(executed), status).toBeNull();
    }
    // Negative control: a real cancel still reads as done.
    expect(toolResultTone("cancelled", true)).toBe("success");
    expect(isSuccessStatus("cancelled")).toBe(true);
  });

  it("circle batch adds succeed only when someone was added", () => {
    // none_added (add_circle_members) and the add_all_connections refusals add
    // nobody; a success tone would tell the person their circle grew.
    for (const status of [
      "none_added",
      "no_one_to_add",
      "not_enough_room",
      "not_added",
    ]) {
      expect(isSuccessStatus(status), status).toBe(false);
      expect(toolResultTone(status, true), status).toBe("neutral");
    }
    // Negative control: a real add still reads as done.
    expect(toolResultTone("added", true)).toBe("success");
    expect(toolResultTone("partially_added", true)).toBe("success");
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

  it("retires a spoken-confirmed candidate before a later provider turn prepares mail", () => {
    const picker = {
      type: "candidate_picker" as const,
      kind: "person" as const,
      question: "Is this who you mean?",
      candidates: [{ user_id: "u-ankit", display_name: "Ankit", relationship: "connected" }],
    };
    const offered = run([server(picker)], connected());
    const unrelated = run([server({
      type: "entity_card", kind: "person", user_id: "u-other", display_name: "Other",
    })], offered);
    expect(unrelated.candidatePicker).not.toBeNull();

    const confirmed = run([
      server({ type: "transcript.input", turn_id: "yes-turn", text: "Yes", final: true }),
      server({
        type: "entity_card", kind: "person", user_id: "u-ankit",
        display_name: "Ankit", turn_id: "yes-turn",
      }),
    ], unrelated);
    expect(confirmed.candidatePicker).toBeNull();
    expect(confirmed.entities.some((entity) => entity.user_id === "u-ankit")).toBe(true);

    const prepared = run([
      server({ type: "turn", state: "model_end", turn_id: "yes-turn" }),
      server(pendingActionFrame({
        tool: "send_mail", summary: "Draft an email to Ankit",
        turn_id: "continuation-turn",
      })),
    ], confirmed);
    expect(prepared.pendingAction?.tool).toBe("send_mail");
    expect(prepared.phase).toBe("confirming");
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

  it("keeps a newer confirmation open when a terminal result names an older action", () => {
    const first = pendingActionFrame({
      pending_action_id: "11111111-0000-4000-8000-000000000003",
      summary: "first",
    });
    const second = pendingActionFrame({
      pending_action_id: "11111111-0000-4000-8000-000000000004",
      summary: "second",
    });
    const state = run(
      [
        server(first),
        server(second),
        server(
          toolResult({
            tool: "share_with",
            pending_action_id: first.pending_action_id,
            status: "share_created",
            ok: true,
            result_public: { status: "share_created" },
          }),
        ),
      ],
      connected(),
    );

    expect(state.pendingAction?.pending_action_id).toBe(second.pending_action_id);
    expect(state.pendingAction?.resolvedStatus).toBeNull();
    expect(state.pendingAction?.receiptToken).toBe("receipt-1");
    expect(state.phase).toBe("confirming");
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
    // The relay survives a voice storage blip on a tap or cancel and keeps
    // the session open, so the client must not strand it in "error".
    const storage = run(
      [
        server({
          type: "error",
          code: "storage_unavailable",
          message: "That didn't go through. Please try again.",
        }),
      ],
      base,
    );
    expect(storage.phase).toBe("listening");
    expect(storage.error?.recoverable).toBe(true);
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
    expect(toolResultTone("draft_open_unconfirmed", false)).toBe("neutral");
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
