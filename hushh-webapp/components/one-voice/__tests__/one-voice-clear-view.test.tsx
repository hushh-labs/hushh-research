import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OneVoicePanel,
  panelHasContent,
} from "@/components/one-voice/one-voice-panel";
import type { ServerFrame } from "@/lib/one-voice/protocol";
import { reduceVoiceSession } from "@/lib/one-voice/session-reducer";
import {
  INITIAL_VOICE_SESSION_STATE,
  type VoiceSessionController,
  type VoiceSessionState,
} from "@/lib/one-voice/session-types";

vi.mock("@/components/agent/agent-voice-waveform", () => ({
  AgentVoiceWaveform: () => <div data-testid="waveform" />,
}));

afterEach(cleanup);

const NOW = Date.parse("2026-09-22T10:00:00.000Z");

const ready: ServerFrame = {
  type: "session.ready",
  protocol_version: "one-voice-v1",
  session_id: "sess_1",
  conversation_id: "conv_1",
  model: "gemini-live",
  resumed: false,
  idle_timeout_ms: 60_000,
  session_max_ms: 600_000,
  pending_actions: [],
  setup_progress: null,
  output_mime_type: "audio/pcm;rate=24000",
};

function replay(frames: ServerFrame[]): VoiceSessionState {
  let state = reduceVoiceSession(INITIAL_VOICE_SESSION_STATE, {
    type: "connecting",
    conversationId: "conv_1",
  });
  for (const frame of frames)
    state = reduceVoiceSession(state, { type: "server", frame, now: NOW });
  return state;
}

function controller(
  overrides: Partial<VoiceSessionController> = {},
): VoiceSessionController {
  return {
    enabled: true,
    state: INITIAL_VOICE_SESSION_STATE,
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    setMuted: vi.fn(),
    interrupt: vi.fn(),
    sendText: vi.fn(),
    confirmPending: vi.fn(async () => undefined),
    cancelPending: vi.fn(),
    chooseCandidate: vi.fn(),
    clearView: vi.fn(),
    reportClientStep: vi.fn(),
    ...overrides,
  };
}

const withHistory = () =>
  replay([
    ready,
    {
      type: "transcript.input",
      text: "Share with Priya",
      final: true,
      turn_id: "t1",
    },
    {
      type: "transcript.output",
      text: "Sharing with Priya now.",
      final: true,
      turn_id: "t1",
    },
  ]);

describe("Clear chat view", () => {
  it("asks before clearing, and cancelling changes nothing", () => {
    const ctrl = controller();
    render(<OneVoicePanel state={withHistory()} controller={ctrl} />);

    fireEvent.click(screen.getByTestId("one-voice-clear-history"));
    expect(screen.getByTestId("one-voice-clear-confirm")).toHaveTextContent(
      "Clear chat view?",
    );
    // The wording must not imply the server, Memory or One's context is touched.
    expect(screen.getByTestId("one-voice-clear-confirm")).toHaveTextContent(
      "Voice stays active, and One can still use earlier conversation context.",
    );

    fireEvent.click(screen.getByTestId("one-voice-clear-cancel"));
    expect(screen.queryByTestId("one-voice-clear-confirm")).toBeNull();
    expect(ctrl.clearView).not.toHaveBeenCalled();
    expect(screen.getByRole("log")).toHaveTextContent("Sharing with Priya now.");
  });

  it("clears only the view: no session lifecycle or domain call is made", () => {
    const ctrl = controller();
    render(<OneVoicePanel state={withHistory()} controller={ctrl} />);

    fireEvent.click(screen.getByTestId("one-voice-clear-history"));
    fireEvent.click(screen.getByTestId("one-voice-clear-confirm-action"));

    expect(ctrl.clearView).toHaveBeenCalledTimes(1);
    expect(ctrl.stop).not.toHaveBeenCalled();
    expect(ctrl.interrupt).not.toHaveBeenCalled();
    expect(ctrl.cancelPending).not.toHaveBeenCalled();
    expect(ctrl.confirmPending).not.toHaveBeenCalled();
    expect(ctrl.sendText).not.toHaveBeenCalled();
    expect(ctrl.setMuted).not.toHaveBeenCalled();
    expect(ctrl.start).not.toHaveBeenCalled();
  });

  it("keeps the panel and its controls usable after the history is gone", () => {
    const cleared = reduceVoiceSession(withHistory(), { type: "clear_view" });
    // The dock decides whether to mount the panel at all from this predicate;
    // a cleared view must not make the panel and its toggle disappear.
    expect(panelHasContent(cleared)).toBe(true);

    render(<OneVoicePanel state={cleared} controller={controller()} />);
    expect(screen.getByTestId("one-voice-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("one-voice-transcript-line")).toBeNull();
    expect(screen.getByTestId("one-voice-transcript-empty")).toBeInTheDocument();
    expect(screen.getByTestId("one-voice-clear-history")).toBeDisabled();
  });

  it("does not offer Clear when there is no history to clear", () => {
    render(<OneVoicePanel state={replay([ready])} controller={controller()} />);
    expect(screen.queryByTestId("one-voice-clear-history")).toBeNull();
  });

  it("keeps an in-flight request visible and leaves an unresolved error alone", () => {
    const base = withHistory();
    const state: VoiceSessionState = {
      ...base,
      error: { code: "mic", message: "Microphone blocked", recoverable: true },
    };
    const cleared = reduceVoiceSession(state, { type: "clear_view" });

    // History goes; recovery content is not history.
    expect(cleared.transcript).toEqual([]);
    expect(cleared.error).toEqual(state.error);

    render(<OneVoicePanel state={cleared} controller={controller()} />);
    expect(screen.getByText("Microphone blocked")).toBeInTheDocument();
  });
});

describe("Clear chat view — defects an adversarial review found", () => {
  it("keeps focus on a control through every confirm transition", () => {
    render(<OneVoicePanel state={withHistory()} controller={controller()} />);
    const open = screen.getByTestId("one-voice-clear-history");

    fireEvent.click(open);
    // Focus must land on the decision, not be dropped on the document.
    expect(document.activeElement).toBe(
      screen.getByTestId("one-voice-clear-confirm-action"),
    );

    fireEvent.click(screen.getByTestId("one-voice-clear-cancel"));
    expect(document.activeElement).toBe(
      screen.getByTestId("one-voice-clear-history"),
    );
  });

  it("uses the repo's inline-confirmation role so it is announced", () => {
    render(<OneVoicePanel state={withHistory()} controller={controller()} />);
    fireEvent.click(screen.getByTestId("one-voice-clear-history"));
    const confirm = screen.getByTestId("one-voice-clear-confirm");
    expect(confirm).toHaveAttribute("role", "alertdialog");
    expect(confirm).toHaveAccessibleName("Clear chat view?");
  });

  it("stops claiming 'cleared' once the panel has content again", () => {
    const cleared = reduceVoiceSession(withHistory(), { type: "clear_view" });
    const { rerender } = render(
      <OneVoicePanel state={cleared} controller={controller()} />,
    );
    expect(screen.getByTestId("one-voice-clear-status")).toHaveTextContent(
      "Chat view cleared",
    );

    // A result card arrives: the view is no longer empty, so the notice goes
    // even though no transcript text landed.
    const withResult = {
      ...cleared,
      entities: [{ kind: "person", name: "Priya" }],
    } as typeof cleared;
    rerender(<OneVoicePanel state={withResult} controller={controller()} />);
    expect(screen.getByTestId("one-voice-clear-status")).toHaveTextContent("");
  });

  it("pins the toolbar so the control survives the transcript scrolling", () => {
    render(<OneVoicePanel state={withHistory()} controller={controller()} />);
    // The panel is the scroll container; a static toolbar scrolls out of
    // reach exactly when there is history to clear.
    expect(screen.getByTestId("one-voice-panel-toolbar").className).toContain(
      "sticky",
    );
  });
});
