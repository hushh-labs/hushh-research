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

const toast = vi.hoisted(() => ({ success: vi.fn() }));

vi.mock("@/components/agent/agent-voice-waveform", () => ({
  AgentVoiceWaveform: () => <div data-testid="waveform" />,
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: toast,
}));

afterEach(() => {
  cleanup();
  toast.success.mockReset();
});

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
    expect(toast.success).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith("Chat view cleared");
  });

  it("keeps a compact conversation panel after the history is gone", () => {
    const cleared = reduceVoiceSession(withHistory(), { type: "clear_view" });
    // The dock decides whether to mount the panel at all from this predicate;
    // a cleared view must not make the panel and its toggle disappear.
    expect(panelHasContent(cleared)).toBe(true);

    render(<OneVoicePanel state={cleared} controller={controller()} />);
    expect(screen.getByTestId("one-voice-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("one-voice-transcript-line")).toBeNull();
    expect(screen.getByTestId("one-voice-panel-title")).toHaveTextContent(
      "Conversation",
    );
    expect(screen.getByTestId("one-voice-transcript-empty")).toHaveTextContent(
      "Your messages will appear here.",
    );
    expect(screen.queryByTestId("one-voice-clear-history")).toBeNull();
    expect(screen.queryByTestId("one-voice-clear-status")).toBeNull();
    expect(screen.queryByText("Chat view cleared")).toBeNull();
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
    expect(screen.queryByTestId("one-voice-transcript-empty")).toBeNull();
  });

  it("lets pending decisions and progress own a cleared panel", () => {
    const cleared = reduceVoiceSession(withHistory(), { type: "clear_view" });
    const decision: VoiceSessionState = {
      ...cleared,
      pendingAction: {
        pending_action_id: "pa_1",
        tool: "share_with",
        gateway_action_id: "location.share_selected",
        tier: "voice",
        summary: "Share with Priya",
        args: {},
        status: "pending",
        shown_at: null,
        expires_at: null,
        result: null,
        riskLevel: "medium",
        requiresTap: false,
        entities: [],
        receiptToken: null,
        resolvedStatus: null,
        resolvedResult: null,
      },
    };
    const { rerender } = render(
      <OneVoicePanel state={decision} controller={controller()} />,
    );
    expect(screen.getByTestId("one-voice-pending-action")).toBeInTheDocument();
    expect(screen.queryByTestId("one-voice-transcript-empty")).toBeNull();

    const progress: VoiceSessionState = {
      ...cleared,
      clientStep: {
        stepId: "s1",
        kind: "publish_location_envelopes",
        payload: { purpose: "sos" },
        timeoutS: 25,
      },
    };
    rerender(<OneVoicePanel state={progress} controller={controller()} />);
    expect(screen.getByTestId("one-voice-sos-publishing")).toBeInTheDocument();
    expect(screen.queryByTestId("one-voice-transcript-empty")).toBeNull();
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

    fireEvent.click(screen.getByTestId("one-voice-clear-history"));
    fireEvent.click(screen.getByTestId("one-voice-clear-confirm-action"));
    expect(document.activeElement).toBe(
      screen.getByTestId("one-voice-panel-title"),
    );
  });

  it("uses the repo's inline-confirmation role so it is announced", () => {
    render(<OneVoicePanel state={withHistory()} controller={controller()} />);
    fireEvent.click(screen.getByTestId("one-voice-clear-history"));
    const confirm = screen.getByTestId("one-voice-clear-confirm");
    expect(confirm).toHaveAttribute("role", "alertdialog");
    expect(confirm).toHaveAccessibleName("Clear chat view?");
  });

  it("uses a labelled header utility while history is available", () => {
    render(<OneVoicePanel state={withHistory()} controller={controller()} />);
    const clear = screen.getByTestId("one-voice-clear-history");
    expect(screen.getByTestId("one-voice-panel-header").className).toContain(
      "sticky",
    );
    expect(clear).toHaveAccessibleName("Clear chat view");
    expect(clear).toHaveAttribute("title", "Clear chat view");
    expect(clear).toHaveTextContent("Clear view");
  });
});
