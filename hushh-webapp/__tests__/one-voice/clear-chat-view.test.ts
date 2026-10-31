import { describe, expect, it } from "vitest";

import type { ServerFrame } from "@/lib/one-voice/protocol";
import {
  panelHasClearableHistory,
  reduceVoiceSession,
} from "@/lib/one-voice/session-reducer";
import {
  INITIAL_VOICE_SESSION_STATE,
  type VoiceSessionEvent,
  type VoiceSessionState,
} from "@/lib/one-voice/session-types";

import { readyFrame } from "./fixtures/scripted-server";

const NOW = 1_700_000_000_000;
const CONVERSATION = "11111111-2222-4333-8444-555555555555";

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

function connected(): VoiceSessionState {
  return run([
    { type: "connecting", conversationId: CONVERSATION },
    server(readyFrame({ conversation_id: CONVERSATION })),
  ]);
}

/** A finished exchange: one user turn and one complete One turn. */
function withHistory(): VoiceSessionState {
  return run(
    [
      server({
        type: "transcript.input",
        text: "Share with Priya",
        final: true,
        turn_id: "t1",
      }),
      server({
        type: "transcript.output",
        text: "Sharing with Priya now.",
        final: true,
        turn_id: "t1",
      }),
    ],
    connected(),
  );
}

const visibleText = (state: VoiceSessionState) =>
  state.transcript
    .filter((item) => item.text.trim().length > 0)
    .map((item) => item.text);

describe("clear chat view — reducer boundary", () => {
  it("removes displayed history without ending the session", () => {
    const before = withHistory();
    expect(visibleText(before)).toHaveLength(2);

    const after = reduceVoiceSession(before, { type: "clear_view" });

    expect(visibleText(after)).toEqual([]);
    // The live session is untouched: this is a view action, not a teardown.
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.conversationId).toBe(before.conversationId);
    expect(after.phase).toBe(before.phase);
    expect(after.muted).toBe(before.muted);
    expect(after).not.toEqual(INITIAL_VOICE_SESSION_STATE);
  });

  it("keeps excluding a turn that was still streaming when the view was cleared", () => {
    const streaming = run(
      [
        server({
          type: "transcript.output",
          text: "Let me check",
          final: false,
          turn_id: "t9",
        }),
      ],
      withHistory(),
    );

    const cleared = reduceVoiceSession(streaming, { type: "clear_view" });
    expect(visibleText(cleared)).toEqual([]);

    // Further chunks AND the finalization of that same cleared turn stay out.
    const continued = run(
      [
        server({
          type: "transcript.output",
          text: " your circles",
          final: false,
          turn_id: "t9",
        }),
        server({
          type: "transcript.output",
          text: "Let me check your circles.",
          final: true,
          turn_id: "t9",
        }),
      ],
      cleared,
    );
    expect(visibleText(continued)).toEqual([]);
  });

  it("shows a genuinely new turn started after the clear", () => {
    const cleared = reduceVoiceSession(withHistory(), { type: "clear_view" });
    const next = run(
      [
        server({
          type: "transcript.input",
          text: "Who can see me?",
          final: true,
          turn_id: "t10",
        }),
      ],
      cleared,
    );
    expect(visibleText(next)).toEqual(["Who can see me?"]);
  });

  it("stops suppressing once the cleared turn has ended, so the list stays bounded", () => {
    const streaming = run(
      [
        server({
          type: "transcript.output",
          text: "Working",
          final: false,
          turn_id: "t9",
        }),
      ],
      withHistory(),
    );
    const cleared = reduceVoiceSession(streaming, { type: "clear_view" });
    expect(cleared.clearedTurnIds).toContain("t9");

    const ended = run(
      [
        server({
          type: "transcript.output",
          text: "Working on it.",
          final: true,
          turn_id: "t9",
        }),
      ],
      cleared,
    );
    expect(ended.clearedTurnIds).not.toContain("t9");
    expect(visibleText(ended)).toEqual([]);
  });

  it("does not carry a clear boundary into a different conversation", () => {
    const streaming = run(
      [
        server({
          type: "transcript.output",
          text: "Working",
          final: false,
          turn_id: "t9",
        }),
      ],
      withHistory(),
    );
    const cleared = reduceVoiceSession(streaming, { type: "clear_view" });
    expect(cleared.clearedTurnIds).not.toEqual([]);

    // A different conversation (account switch, new chat) starts clean, so a
    // stale boundary can never hide the new scope's first turn.
    const fresh = reduceVoiceSession(cleared, {
      type: "connecting",
      conversationId: "99999999-2222-4333-8444-555555555555",
    });
    expect(fresh.clearedTurnIds).toEqual([]);
    expect(fresh.historyCleared).toBe(false);

    const next = run(
      [
        server({
          type: "transcript.output",
          text: "New conversation.",
          final: true,
          turn_id: "t9",
        }),
      ],
      fresh,
    );
    expect(visibleText(next)).toEqual(["New conversation."]);
  });

  it("enables Clear only for real history, never for pending content alone", () => {
    expect(panelHasClearableHistory(connected())).toBe(false);
    expect(panelHasClearableHistory(withHistory())).toBe(true);
    expect(
      panelHasClearableHistory(
        reduceVoiceSession(withHistory(), { type: "clear_view" }),
      ),
    ).toBe(false);
  });
});

describe("clear chat view — defects an adversarial review found", () => {
  /**
   * One turn id spans BOTH sides of the exchange, and the relay stamps a
   * typed message with the turn that is already in flight. Suppressing by
   * turn id alone therefore swallowed the person's own next message.
   */
  it("shows a message typed after the clear, even on the cleared turn", () => {
    const streaming = run(
      [
        server({
          type: "transcript.output",
          text: "Let me check",
          final: false,
          turn_id: "t9",
        }),
      ],
      withHistory(),
    );
    const cleared = reduceVoiceSession(streaming, { type: "clear_view" });

    // The relay stamps a typed message with the turn already in flight.
    const typed = run(
      [
        server({
          type: "transcript.input",
          text: "actually, who can see me?",
          final: true,
          turn_id: "t9",
        }),
      ],
      cleared,
    );
    expect(visibleText(typed)).toEqual(["actually, who can see me?"]);
  });

  /**
   * Pruning fired on the first `final` of EITHER role, so the user's own
   * final un-suppressed the assistant half and the cleared answer returned.
   */
  it("keeps the cleared answer hidden after the person's own turn finalizes", () => {
    const streaming = run(
      [
        server({
          type: "transcript.input",
          text: "share with Priya",
          final: false,
          turn_id: "t9",
        }),
        server({
          type: "transcript.output",
          text: "Sharing now",
          final: false,
          turn_id: "t9",
        }),
      ],
      withHistory(),
    );
    const cleared = reduceVoiceSession(streaming, { type: "clear_view" });

    const after = run(
      [
        // The person's half finalizes first...
        server({
          type: "transcript.input",
          text: "share with Priya",
          final: true,
          turn_id: "t9",
        }),
        // ...which must not bring the cleared answer back.
        server({
          type: "transcript.output",
          text: "Sharing now with Priya.",
          final: true,
          turn_id: "t9",
        }),
      ],
      cleared,
    );
    expect(after.transcript.map((i) => i.role)).not.toContain("one");
  });
});
