import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OneVoicePanel,
  isHandoffResult,
  panelHasContent,
  selectPanelResult,
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = Date.parse("2026-09-15T10:00:00.000Z");

// The pending card disables Confirm once `expires_at` passes in real time, so
// the clock is pinned to the same instant the frames are stamped with.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

function replay(
  frames: ServerFrame[],
  from: VoiceSessionState = INITIAL_VOICE_SESSION_STATE,
): VoiceSessionState {
  let state = reduceVoiceSession(from, {
    type: "connecting",
    conversationId: "conv_1",
  });
  for (const frame of frames)
    state = reduceVoiceSession(state, { type: "server", frame, now: NOW });
  return state;
}

const ready: ServerFrame = {
  type: "session.ready",
  protocol_version: "one-voice-v1",
  session_id: "sess_SECRET",
  conversation_id: "conv_1",
  model: "gemini-live",
  resumed: false,
  idle_timeout_ms: 60_000,
  session_max_ms: 600_000,
  pending_actions: [],
  setup_progress: null,
  output_mime_type: "audio/pcm;rate=24000",
};

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
    reportClientStep: vi.fn(),
    ...overrides,
  };
}

describe("OneVoicePanel", () => {
  it("never shows Done from transcript text or a bare complete state", () => {
    const state = replay([
      ready,
      {
        type: "transcript.input",
        text: "Share my location with Priya",
        final: true,
        turn_id: "t1",
      },
      {
        type: "transcript.output",
        text: "Done, I've shared your location with Priya.",
        final: true,
        turn_id: "t1",
      },
      { type: "state", state: "complete", turn_id: "t1" },
    ]);
    render(<OneVoicePanel state={state} controller={controller()} />);
    expect(screen.getByRole("log")).toHaveTextContent(
      "Done, I've shared your location with Priya.",
    );
    expect(screen.queryByTestId("one-voice-tool-result")).toBeNull();
    expect(screen.queryByTestId("one-voice-tool-result-headline")).toBeNull();
    expect(selectPanelResult(state)).toBeNull();
  });

  it("shows Done only from tool.result ok:true with a success status", () => {
    const state = replay([
      ready,
      {
        type: "tool.started",
        call_id: "c1",
        tool: "rename_circle",
        args_public: {},
      },
      {
        type: "tool.result",
        call_id: "c1",
        tool: "rename_circle",
        status: "renamed",
        ok: true,
        result_public: {
          status: "renamed",
          spoken_facts: ["Renamed Family to Home."],
        },
      },
    ]);
    render(<OneVoicePanel state={state} controller={controller()} />);
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Done");
    expect(screen.getByText("Renamed Family to Home.")).toBeInTheDocument();
  });

  it("hides a confirmation_required result behind the pending card and confirms through the controller", async () => {
    const control = controller();
    const state = replay([
      ready,
      {
        type: "tool.started",
        call_id: "c1",
        tool: "share_with",
        args_public: {},
      },
      {
        type: "tool.result",
        call_id: "c1",
        tool: "share_with",
        status: "confirmation_required",
        ok: false,
        result_public: {
          status: "confirmation_required",
          needs: "confirmation",
          spoken_facts: ["Should I share with Priya?"],
        },
      },
      {
        type: "pending_action",
        pending_action_id: "pa_SECRET",
        tool: "share_with",
        gateway_action_id: "location.share_selected",
        tier: "voice",
        summary: "Share your location with Priya Sharma for 1 hour",
        args: {},
        status: "pending",
        shown_at: null,
        expires_at: new Date(NOW + 120_000).toISOString(),
        result: null,
        risk_level: "medium",
        requires_tap: false,
        entities: [
          {
            kind: "person",
            user_id: "usr_SECRET",
            display_name: "Priya Sharma",
            relationship: "connected",
          },
        ],
        receipt_token: "rt_SECRET",
      },
    ]);
    const { container } = render(
      <OneVoicePanel state={state} controller={control} />,
    );
    expect(state.phase).toBe("confirming");
    expect(screen.queryByTestId("one-voice-tool-result")).toBeNull();
    expect(screen.getByTestId("one-voice-pending-action")).toHaveFocus();
    expect(
      screen.getByTestId("one-voice-pending-instruction"),
    ).toHaveTextContent("Say yes, or tap Confirm");
    expect(container.textContent).not.toMatch(
      /usr_SECRET|pa_SECRET|rt_SECRET|sess_SECRET/,
    );
    // The confirmed entity is shown inside the card, not duplicated above it.
    expect(screen.getAllByTestId("one-voice-entity-card")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("one-voice-pending-confirm"));
    await waitFor(() =>
      expect(control.confirmPending).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByTestId("one-voice-pending-cancel"));
    expect(control.cancelPending).toHaveBeenCalledTimes(1);
    expect(
      isHandoffResult({ status: "tap_required" }, { candidatePicker: null }),
    ).toBe(true);
  });

  it("renders the resolved receipt once when resolved and tool.result carry the same payload", () => {
    const pendingFrame: ServerFrame = {
      type: "pending_action",
      pending_action_id: "pa_1",
      tool: "delete_circle",
      gateway_action_id: "location.delete_circle",
      tier: "tap",
      summary: "Delete the Family circle",
      args: {},
      status: "pending",
      shown_at: null,
      expires_at: null,
      result: null,
      risk_level: "high",
      requires_tap: true,
      entities: [],
    };
    const payload = {
      status: "deleted",
      spoken_facts: ["Deleted the Family circle."],
    };
    const state = replay([
      ready,
      pendingFrame,
      {
        type: "pending_action.resolved",
        pending_action_id: "pa_1",
        status: "executed",
        result_public: payload,
      },
      {
        type: "tool.result",
        call_id: null,
        tool: "delete_circle",
        status: "deleted",
        ok: true,
        result_public: { ...payload },
      },
    ]);
    render(<OneVoicePanel state={state} controller={controller()} />);
    expect(screen.getByTestId("one-voice-pending-resolved")).toHaveTextContent(
      "Done",
    );
    expect(screen.getAllByTestId("one-voice-tool-result")).toHaveLength(1);
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Done");
    expect(screen.queryByTestId("one-voice-pending-confirm")).toBeNull();
  });

  it("routes the candidate picker to chooseCandidate and 'None of these' to null", () => {
    const control = controller();
    const state = replay([
      ready,
      {
        type: "candidate_picker",
        kind: "person",
        question: "Which Alex?",
        candidates: [
          {
            user_id: "usr_a",
            display_name: "Alex Chen",
            relationship: "connected",
          },
          {
            user_id: "usr_b",
            display_name: "Alex Rivera",
            relationship: "none",
          },
        ],
      },
    ]);
    render(<OneVoicePanel state={state} controller={control} />);
    fireEvent.click(screen.getAllByRole("radio")[1]!);
    expect(control.chooseCandidate).toHaveBeenCalledWith("usr_b");
    expect(screen.getAllByRole("radio")[1]).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByTestId("one-voice-candidate-none"));
    expect(control.chooseCandidate).toHaveBeenLastCalledWith(null);
  });

  it("shows a mic-permission error with settings and retry wired to the controller", () => {
    const control = controller();
    const onOpenSettings = vi.fn();
    const onDismissError = vi.fn();
    let state = replay([ready]);
    state = reduceVoiceSession(state, {
      type: "local_error",
      error: {
        code: "not_allowed",
        message: "Microphone access is blocked.",
        recoverable: false,
      },
    });
    render(
      <OneVoicePanel
        state={state}
        controller={control}
        onOpenSettings={onOpenSettings}
        onDismissError={onDismissError}
      />,
    );
    expect(state.phase).toBe("error");
    fireEvent.click(screen.getByTestId("one-voice-error-open-settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("one-voice-error-retry"));
    expect(control.start).toHaveBeenCalledWith({ source: "retry" });
    fireEvent.click(screen.getByTestId("one-voice-error-dismiss"));
    expect(onDismissError).toHaveBeenCalledTimes(1);
  });

  it("reports whether there is anything to show and never covers the page", () => {
    expect(panelHasContent(INITIAL_VOICE_SESSION_STATE)).toBe(false);
    const state = replay([
      ready,
      { type: "transcript.input", text: "Hi", final: false, turn_id: "t1" },
    ]);
    expect(panelHasContent(state)).toBe(true);
    render(<OneVoicePanel state={state} controller={controller()} />);
    const panel = screen.getByTestId("one-voice-panel");
    expect(panel.className).toContain("max-h-[min(52dvh,420px)]");
    expect(panel.className).toContain("overflow-y-auto");
    expect(panel.className).toContain("bottom-chrome-surface");
    expect(panel.className).not.toContain("backdrop-blur");
    expect(panel.className).not.toContain("fixed");
    expect(panel.className).not.toContain("inset-0");
  });
});
