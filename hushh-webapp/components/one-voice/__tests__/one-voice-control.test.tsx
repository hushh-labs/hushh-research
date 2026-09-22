import fs from "node:fs";
import path from "node:path";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OneVoiceControl } from "@/components/one-voice/one-voice-control";
import { useAgentVoiceState } from "@/lib/agent/agent-voice-state";
import { navigateToAgentChat } from "@/lib/navigation/agent-navigation";
import type { ServerFrame } from "@/lib/one-voice/protocol";
import {
  dispatchServerFrame,
  useVoiceSessionStore,
} from "@/lib/one-voice/session-store";
import {
  INITIAL_VOICE_SESSION_STATE,
  type VoiceSessionController,
} from "@/lib/one-voice/session-types";

const harness = vi.hoisted(() => ({
  pathname: "/one/location",
  user: { uid: "owner" } as { uid: string } | null,
  native: false,
  openSettings: vi.fn(async () => ({ opened: true })),
  session: null as VoiceSessionController | null,
}));

vi.mock("next/navigation", () => ({ usePathname: () => harness.pathname }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: harness.user }),
}));
vi.mock("@/lib/navigation/agent-navigation", () => ({
  navigateToAgentChat: vi.fn(),
}));
vi.mock("@/lib/capacitor/platform", () => ({ isNative: () => harness.native }));
vi.mock("@/lib/capacitor/one-voice-invocation", () => ({
  NativeOneVoiceInvocation: {
    openCommandCaptureSettings: harness.openSettings,
  },
}));
vi.mock("@/components/one-voice/voice-session-provider", () => ({
  useVoiceSession: () => {
    if (!harness.session) throw new Error("session not set");
    return harness.session;
  },
}));
vi.mock("@/components/agent/agent-voice-waveform", () => ({
  AgentVoiceWaveform: () => <div data-testid="waveform" />,
}));

function makeSession(): VoiceSessionController {
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
  };
}

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

function connect() {
  act(() => {
    useVoiceSessionStore
      .getState()
      .dispatch({ type: "connecting", conversationId: "conv_1" });
    dispatchServerFrame(ready);
  });
}

beforeEach(() => {
  harness.session = makeSession();
  harness.native = false;
  vi.mocked(navigateToAgentChat).mockClear();
  act(() => {
    useVoiceSessionStore.getState().reset();
    useAgentVoiceState.getState().reset();
  });
});

afterEach(() => cleanup());

describe("OneVoiceControl", () => {
  it("idles as the Talk to One pill with the launcher identity and starts a session on tap", () => {
    render(<OneVoiceControl layout="slot" />);
    const dock = screen.getByTestId("one-voice-agent-bar");
    expect(dock).toHaveAttribute("data-agent-dock", "one-agent-dock");
    expect(dock).toHaveAttribute("role", "group");
    expect(dock).toHaveAccessibleName("One private agent");
    expect(dock.className).toContain("bottom-chrome-surface");
    expect(dock.className).not.toContain("backdrop-blur");
    expect(dock.className).toContain("var(--app-agent-bar-max-width)");

    const start = screen.getByTestId("one-voice-agent-bar-start-icon");
    expect(start).toHaveAttribute(
      "data-native-voice-control-id",
      "one_voice_agent_bar_start",
    );
    expect(start).toHaveAttribute("data-agent-action", "voice");
    expect(start).toHaveTextContent("Talk to One");
    fireEvent.click(start);
    expect(harness.session!.start).toHaveBeenCalledWith({
      source: "agent_bar",
    });

    expect(screen.queryByTestId("one-voice-panel")).toBeNull();
    expect(screen.queryByTestId("one-voice-stop")).toBeNull();
    expect(screen.queryByTestId("one-agent-chat-open")).toBeNull();
  });

  it("seats layout=fixed above the nav with the shared bottom variable", () => {
    render(<OneVoiceControl layout="fixed" />);
    const shell = document.querySelector<HTMLElement>("[data-agent-bar-shell]");
    expect(shell).not.toBeNull();
    expect(shell).toHaveAttribute("data-agent-bar-layout", "fixed");
    expect(shell!.style.bottom).toBe("var(--agent-bar-with-nav-bottom)");
    expect(shell!.className).toContain("fixed");
  });

  it("becomes the state pill once the session is live and stops with the tap reason", () => {
    render(<OneVoiceControl layout="slot" />);
    connect();
    expect(screen.getByTestId("one-voice-agent-bar")).toHaveAttribute(
      "data-voice-phase",
      "listening",
    );
    expect(screen.getByTestId("one-voice-state-label")).toHaveTextContent(
      "Listening",
    );
    expect(
      screen.getByTestId("one-voice-agent-bar-start-icon"),
    ).toHaveAttribute(
      "data-native-voice-control-id",
      "one_voice_agent_bar_start",
    );
    expect(screen.queryByTestId("one-agent-chat-open")).toBeNull();

    fireEvent.click(screen.getByTestId("one-voice-mute"));
    expect(harness.session!.setMuted).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId("one-voice-agent-bar-start-icon"));
    expect(harness.session!.interrupt).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("one-voice-stop"));
    expect(harness.session!.stop).toHaveBeenCalledWith("tap");
    // The shell keeps the bottom chrome visible while a session runs.
    expect(useAgentVoiceState.getState().active).toBe(true);
  });

  it("minimizes the conversation without stopping it, retains its status, and restores it", () => {
    render(<OneVoiceControl layout="slot" />);
    connect();
    expect(screen.queryByTestId("one-voice-panel")).toBeNull();
    act(() => {
      dispatchServerFrame({
        type: "transcript.input",
        text: "Share with Priya",
        final: true,
        turn_id: "t1",
      });
    });
    const shell = document.querySelector<HTMLElement>(
      "[data-agent-bar-shell]",
    )!;
    const panel = screen.getByTestId("one-voice-panel");
    const dock = screen.getByTestId("one-voice-agent-bar");
    // Panel precedes the pill in the column: it sits above.
    expect(
      panel.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(shell.className).not.toContain("inset-0");
    expect(dock).toHaveAttribute("data-voice-panel", "open");
    expect(screen.queryByTestId("one-voice-status-line")).toBeNull();

    const toggle = screen.getByTestId("one-voice-toggle-panel");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Minimize voice panel");
    expect(toggle).toHaveTextContent("Minimize");
    fireEvent.click(toggle);
    expect(screen.queryByTestId("one-voice-panel")).toBeNull();
    expect(dock).toHaveAttribute("data-voice-panel", "collapsed");
    expect(screen.getByTestId("one-voice-status-line")).toHaveTextContent(
      "You said: Share with Priya",
    );
    expect(harness.session!.stop).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAccessibleName("Expand voice panel");
    expect(toggle).toHaveTextContent("Expand");

    fireEvent.click(toggle);
    expect(screen.getByTestId("one-voice-panel")).toBeInTheDocument();
    expect(screen.getByTestId("one-voice-transcript-line")).toHaveTextContent(
      "Share with Priya",
    );
    expect(harness.session!.stop).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(screen.queryByTestId("one-voice-panel")).toBeNull();

    // A pending action reopens the panel and focuses the card.
    act(() => {
      dispatchServerFrame({
        type: "pending_action",
        pending_action_id: "pa_1",
        tool: "share_with",
        gateway_action_id: "location.share_selected",
        tier: "voice",
        summary: "Share your location with Priya Sharma for 1 hour",
        args: {},
        status: "pending",
        shown_at: null,
        expires_at: null,
        result: null,
        risk_level: "medium",
        requires_tap: false,
        entities: [],
      });
    });
    expect(screen.getByTestId("one-voice-panel")).toBeInTheDocument();
    expect(screen.getByTestId("one-voice-pending-action")).toHaveFocus();
    expect(screen.getByTestId("one-voice-state-label")).toHaveTextContent(
      "Confirm to continue",
    );
  });

  it("reopens a collapsed panel on Home while a Save My Soul position is being sent", () => {
    harness.pathname = "/one";
    try {
      render(<OneVoiceControl layout="fixed" />);
      connect();
      act(() => {
        dispatchServerFrame({
          type: "transcript.input",
          text: "Send my SOS",
          final: true,
          turn_id: "t1",
        });
      });
      fireEvent.click(screen.getByTestId("one-voice-toggle-panel"));
      expect(screen.queryByTestId("one-voice-panel")).toBeNull();

      act(() => {
        dispatchServerFrame({
          type: "client_step.request",
          step_id: "step_SECRET",
          kind: "publish_location_envelopes",
          payload: { purpose: "sos", sos: true, grant_ids: ["g1"] },
          timeout_s: 25,
        });
      });
      expect(screen.getByTestId("one-voice-agent-bar")).toHaveAttribute(
        "data-voice-panel",
        "open",
      );
      expect(screen.getByTestId("one-voice-sos-publishing")).toHaveTextContent(
        "Sending your position…",
      );
      expect(document.body.textContent).not.toContain("Done");
      expect(document.body.textContent).not.toContain("step_SECRET");

      act(() => {
        useVoiceSessionStore
          .getState()
          .dispatch({ type: "client_step_done", stepId: "step_SECRET" });
      });
      expect(screen.queryByTestId("one-voice-sos-publishing")).toBeNull();
    } finally {
      harness.pathname = "/one/location";
    }
  });

  it("offers a hidden Type instead affordance that sends through session.sendText", () => {
    render(<OneVoiceControl layout="slot" />);
    connect();
    const toggle = screen.getByTestId("one-voice-type-instead");
    expect(toggle.className).toContain("sr-only");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    const input = screen.getByTestId("one-voice-type-input");
    fireEvent.change(input, {
      target: { value: "share my location with Priya" },
    });
    fireEvent.submit(screen.getByTestId("one-voice-type-form"));
    expect(harness.session!.sendText).toHaveBeenCalledWith(
      "share my location with Priya",
    );
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("starts a session before sending typed text while idle", async () => {
    render(<OneVoiceControl layout="slot" />);
    fireEvent.click(screen.getByTestId("one-voice-type-instead"));
    fireEvent.change(screen.getByTestId("one-voice-type-input"), {
      target: { value: "who can see me" },
    });
    fireEvent.submit(screen.getByTestId("one-voice-type-form"));
    expect(harness.session!.start).toHaveBeenCalledWith({ source: "typed" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.session!.sendText).toHaveBeenCalledWith("who can see me");
  });

  it("keeps a failed start visible with retry, and opens OS settings only on native", async () => {
    harness.native = true;
    render(<OneVoiceControl layout="slot" />);
    act(() => {
      useVoiceSessionStore.getState().dispatch({
        type: "local_error",
        error: {
          code: "not_allowed",
          message: "Microphone access is blocked.",
          recoverable: false,
        },
      });
    });
    expect(useVoiceSessionStore.getState().state.phase).toBe("idle");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Microphone access is blocked",
    );
    expect(
      screen.getByTestId("one-voice-agent-bar-start-icon"),
    ).toHaveTextContent("Try again");
    fireEvent.click(screen.getByTestId("one-voice-error-open-settings"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.openSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("one-voice-error-retry"));
    expect(harness.session!.start).toHaveBeenCalledWith({ source: "retry" });
    fireEvent.click(screen.getByTestId("one-voice-error-dismiss"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useVoiceSessionStore.getState().state.error).toBeNull();
  });

  it("listens for the focus_pending_action directive under the same event name the directives module emits", () => {
    const directives = fs.readFileSync(
      path.resolve(__dirname, "../../../lib/one-voice/directives.ts"),
      "utf8",
    );
    const control = fs.readFileSync(
      path.resolve(__dirname, "../one-voice-control.tsx"),
      "utf8",
    );
    const emitted = directives.match(
      /ONE_VOICE_FOCUS_PENDING_EVENT = "([^"]+)"/,
    )?.[1];
    const listened = control.match(/FOCUS_PENDING_EVENT = "([^"]+)"/)?.[1];
    expect(emitted).toBeDefined();
    expect(listened).toBe(emitted);
    // The launcher's module graph stays light: no API service, no plugin registry.
    expect(control).not.toContain("@/lib/one-voice/directives");
    expect(control).not.toContain("@/lib/services/api-service");

    render(<OneVoiceControl layout="slot" />);
    connect();
    act(() => {
      dispatchServerFrame({
        type: "pending_action",
        pending_action_id: "pa_2",
        tool: "stop_share",
        gateway_action_id: "location.stop_share",
        tier: "tap",
        summary: "Stop sharing with Priya Sharma",
        args: {},
        status: "pending",
        shown_at: null,
        expires_at: null,
        result: null,
        risk_level: "high",
        requires_tap: true,
        entities: [],
      });
    });
    fireEvent.click(screen.getByTestId("one-voice-toggle-panel"));
    expect(screen.queryByTestId("one-voice-panel")).toBeNull();
    vi.useFakeTimers();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(emitted!, { detail: { pendingActionId: "pa_2" } }),
      );
      vi.runAllTimers();
    });
    vi.useRealTimers();
    expect(screen.getByTestId("one-voice-panel")).toBeInTheDocument();
    expect(screen.getByTestId("one-voice-pending-action")).toHaveFocus();
  });

  it("keeps the idle dock visible while chat is a route-level workspace", () => {
    render(<OneVoiceControl layout="slot" />);
    expect(screen.getByTestId("one-voice-agent-bar")).not.toHaveAttribute(
      "aria-hidden",
    );
    connect();
    expect(screen.getByTestId("one-voice-agent-bar")).not.toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
