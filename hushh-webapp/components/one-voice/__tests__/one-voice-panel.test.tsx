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
  isSosPublishStep,
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
    clearView: vi.fn(),
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

  it("removes the confirmation card when resolved and tool.result carry the same payload", () => {
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
    expect(screen.queryByTestId("one-voice-pending-action")).toBeNull();
    expect(screen.getAllByTestId("one-voice-tool-result")).toHaveLength(1);
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Done");
    expect(screen.queryByTestId("one-voice-pending-confirm")).toBeNull();
  });

  it("retires only the matching Circle confirmation when its terminal result arrives", () => {
    const pendingActionId = "pa-circle";
    const payload = {
      status: "created",
      spoken_facts: ["Created the Goa Circle."],
    };
    const state = replay([
      ready,
      {
        type: "pending_action",
        pending_action_id: pendingActionId,
        tool: "create_circle",
        gateway_action_id: "location.create_circle",
        tier: "voice",
        summary: "create a circle called Goa Circle",
        args: {},
        status: "pending",
        shown_at: null,
        expires_at: null,
        result: null,
        risk_level: "low",
        requires_tap: false,
        entities: [],
      },
      {
        type: "tool.result",
        call_id: null,
        pending_action_id: pendingActionId,
        tool: "create_circle",
        status: "created",
        ok: true,
        result_public: payload,
      },
    ]);

    expect(state.pendingAction?.resolvedStatus).toBe("executed");
    expect(state.pendingAction?.receiptToken).toBeNull();
    render(<OneVoicePanel state={state} controller={controller()} />);
    expect(screen.queryByTestId("one-voice-pending-action")).toBeNull();
    expect(screen.queryByTestId("one-voice-pending-confirm")).toBeNull();
    expect(screen.getAllByTestId("one-voice-tool-result")).toHaveLength(1);
    expect(screen.getByTestId("one-voice-tool-result")).toHaveAttribute(
      "data-tool",
      "create_circle",
    );
    expect(screen.getByText("Created the Goa Circle.")).toBeInTheDocument();
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

  it("renders no result card for a location_updates_pending result; the settled result gets the card", () => {
    const pending = replay([
      ready,
      { type: "state", state: "executing" },
      {
        type: "tool.started",
        call_id: "c-device",
        tool: "resume_device_location_updates",
        args_public: {},
      },
      {
        type: "tool.result",
        call_id: "c-device",
        tool: "resume_device_location_updates",
        status: "location_updates_pending",
        ok: false,
        result_public: { status: "location_updates_pending" },
      },
    ]);
    expect(pending.lastResult?.status).toBe("location_updates_pending");
    expect(
      isHandoffResult(
        { status: "location_updates_pending" },
        { candidatePicker: null },
      ),
    ).toBe(true);
    expect(selectPanelResult(pending)).toBeNull();
    const { unmount } = render(
      <OneVoicePanel state={pending} controller={controller()} />,
    );
    expect(screen.queryByTestId("one-voice-tool-result")).toBeNull();
    expect(screen.queryByTestId("one-voice-tool-result-headline")).toBeNull();
    unmount();

    const settled = replay(
      [
        {
          type: "tool.result",
          call_id: "c-device",
          tool: "resume_device_location_updates",
          status: "on",
          ok: true,
          result_public: { status: "on", spoken_facts: ["Location is on."] },
        },
        { type: "state", state: "complete" },
      ],
      pending,
    );
    expect(selectPanelResult(settled)).toMatchObject({
      tool: "resume_device_location_updates",
      ok: true,
      result: { status: "on" },
    });
    render(<OneVoicePanel state={settled} controller={controller()} />);
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Done");
    expect(screen.getByText("Location is on.")).toBeInTheDocument();
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

describe("OneVoicePanel: Save My Soul", () => {
  const sosCard: ServerFrame = {
    type: "pending_action",
    pending_action_id: "pa_SECRET_sos",
    tool: "trigger_save_my_soul",
    gateway_action_id: "location.trigger_sos",
    tier: "tap",
    summary: "Send a Save My Soul alert to Priya Nair and Rahul Mehta",
    args: {},
    status: "pending",
    shown_at: null,
    expires_at: new Date(NOW + 120_000).toISOString(),
    result: null,
    risk_level: "high",
    requires_tap: true,
    entities: [],
    receipt_token: "rt_SECRET",
  };
  const armed = {
    status: "sos_grants_created",
    spoken_facts: [
      "Alert armed for Priya Nair and Rahul Mehta; sending your position now.",
    ],
    grant_ids: ["grant_SECRET_a", "grant_SECRET_b"],
    armed: [
      { grant_id: "grant_SECRET_a", user_id: "usr_SECRET_a", display_name: "Priya Nair" },
      { grant_id: "grant_SECRET_b", user_id: "usr_SECRET_b", display_name: "Rahul Mehta" },
    ],
    client_step: {
      kind: "publish_location_envelopes",
      purpose: "sos",
      sos: true,
      grant_ids: ["grant_SECRET_a", "grant_SECRET_b"],
    },
  };
  const armedFrames: ServerFrame[] = [
    ready,
    { type: "state", state: "confirming" },
    sosCard,
    { type: "state", state: "executing" },
    {
      type: "pending_action.resolved",
      pending_action_id: "pa_SECRET_sos",
      status: "executed",
      result_public: armed,
    },
    {
      type: "tool.result",
      call_id: null,
      tool: "trigger_save_my_soul",
      status: "sos_grants_created",
      ok: false,
      result_public: { ...armed },
    },
    {
      type: "client_step.request",
      step_id: "step_SECRET",
      kind: "publish_location_envelopes",
      payload: {
        purpose: "sos",
        sos: true,
        grant_ids: ["grant_SECRET_a", "grant_SECRET_b"],
        grants: [
          { grant_id: "grant_SECRET_a", user_id: "usr_SECRET_a", key_id: "k_a" },
          { grant_id: "grant_SECRET_b", user_id: "usr_SECRET_b", key_id: "k_b" },
        ],
        timeout_s: 25,
      },
      timeout_s: 25,
    },
    { type: "state", state: "listening" },
  ];

  it("shows the armed card and 'Sending your position…' while the device publishes, never Done or a failure", () => {
    const state = replay(armedFrames);
    expect(state.clientStep?.stepId).toBe("step_SECRET");
    expect(isSosPublishStep(state.clientStep)).toBe(true);
    const { container } = render(
      <OneVoicePanel state={state} controller={controller()} />,
    );
    expect(screen.getByTestId("one-voice-pending-resolved")).toHaveTextContent(
      "Armed · sending your position",
    );
    expect(screen.getByTestId("one-voice-sos-publishing")).toHaveTextContent(
      "Sending your position…",
    );
    // One SOS result card, in the pending tone.
    expect(screen.getAllByTestId("one-voice-tool-result")).toHaveLength(1);
    expect(screen.getByTestId("one-voice-tool-result")).toHaveAttribute(
      "data-tone",
      "pending",
    );
    expect(container.textContent).not.toContain("Done");
    expect(container.textContent).not.toContain("didn't go through");
    expect(container.textContent).not.toMatch(/\bSent\b/);
    expect(container.textContent).not.toMatch(
      /grant_SECRET|usr_SECRET|pa_SECRET|rt_SECRET|step_SECRET/,
    );
    expect(screen.queryByTestId("one-voice-pending-confirm")).toBeNull();
  });

  it("the publishing phase alone is enough to open the panel, and it clears when the step is reported", () => {
    const state = reduceVoiceSession(replay([ready]), {
      type: "server",
      frame: {
        type: "client_step.request",
        step_id: "s1",
        kind: "publish_location_envelopes",
        payload: { purpose: "sos", sos: true, grant_ids: ["g1"] },
        timeout_s: 25,
      },
      now: NOW,
    });
    expect(panelHasContent(state)).toBe(true);
    const { unmount } = render(
      <OneVoicePanel state={state} controller={controller()} />,
    );
    expect(screen.getByTestId("one-voice-sos-publishing")).toBeInTheDocument();
    unmount();

    const done = reduceVoiceSession(state, {
      type: "client_step_done",
      stepId: "s1",
    });
    expect(panelHasContent(done)).toBe(false);
    render(<OneVoicePanel state={done} controller={controller()} />);
    expect(screen.queryByTestId("one-voice-sos-publishing")).toBeNull();
  });

  it("only a Save My Soul publish step shows the phase; a check-in publish does not", () => {
    expect(
      isSosPublishStep({
        stepId: "s",
        kind: "publish_location_envelopes",
        payload: { purpose: "check_in", grant_ids: ["g1"] },
        timeoutS: 25,
      }),
    ).toBe(false);
    expect(
      isSosPublishStep({
        stepId: "s",
        kind: "publish_location_envelopes",
        payload: { sos: true, grant_ids: ["g1"] },
        timeoutS: 25,
      }),
    ).toBe(true);
    expect(
      isSosPublishStep({
        stepId: "s",
        kind: "register_recipient_key",
        payload: { purpose: "sos" },
        timeoutS: 25,
      }),
    ).toBe(false);
    expect(isSosPublishStep(null)).toBe(false);
  });

  it("after the socket closes mid-publish the card and the result read unconfirmed, and nothing spins", () => {
    const base = replay(armedFrames);
    const closed = reduceVoiceSession(base, {
      type: "closed",
      code: 1000,
      reason: "local:stop",
      now: NOW,
    });
    expect(closed.clientStep).toBeNull();
    const { container } = render(
      <OneVoicePanel state={closed} controller={controller()} />,
    );
    expect(screen.queryByTestId("one-voice-sos-publishing")).toBeNull();
    expect(screen.getByTestId("one-voice-pending-resolved")).toHaveTextContent(
      "Couldn't confirm delivery",
    );
    expect(screen.getAllByTestId("one-voice-tool-result")).toHaveLength(1);
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Couldn't confirm delivery");
    expect(screen.getByTestId("one-voice-tool-result")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
    expect(container.textContent).toContain(
      "The connection dropped before delivery was confirmed.",
    );
    expect(container.textContent).not.toMatch(
      /\bSent\b|Not sent|sending your position|Done|didn't go through/,
    );
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.textContent).not.toMatch(/grant_SECRET|usr_SECRET/);
  });

  it("replaces the armed card with the verified report: Sent only for sos_sent, one card either way", () => {
    const base = replay(armedFrames);
    const partial = {
      status: "sos_partial",
      spoken_facts: [
        "Your position reached Priya Nair.",
        "Your position has not reached Rahul Mehta; their share is armed but nothing was sent to them.",
      ],
      delivered: ["Priya Nair"],
      not_alerted: ["Rahul Mehta"],
      delivered_grant_ids: ["grant_SECRET_a"],
      not_alerted_grant_ids: ["grant_SECRET_b"],
      alert_active: true,
      device_step: { status: "ok", late: false },
    };
    const partlySent = replay(
      [
        {
          type: "pending_action.resolved",
          pending_action_id: "pa_SECRET_sos",
          status: "executed",
          result_public: partial,
        },
        {
          type: "tool.result",
          call_id: null,
          tool: "report_save_my_soul_delivery",
          status: "sos_partial",
          ok: true,
          result_public: { ...partial },
        },
        { type: "state", state: "complete" },
      ],
      reduceVoiceSession(base, { type: "client_step_done", stepId: "step_SECRET" }),
    );
    expect(partlySent.toolTimeline).toHaveLength(1);
    const { container, unmount } = render(
      <OneVoicePanel state={partlySent} controller={controller()} />,
    );
    expect(screen.queryByTestId("one-voice-sos-publishing")).toBeNull();
    expect(screen.getByTestId("one-voice-pending-resolved")).toHaveTextContent(
      "Partly sent",
    );
    expect(screen.getAllByTestId("one-voice-tool-result")).toHaveLength(1);
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Partly sent");
    expect(screen.getByRole("list", { name: "Reached" })).toHaveTextContent(
      "Priya Nair",
    );
    expect(screen.getByRole("list", { name: "Not reached" })).toHaveTextContent(
      "Rahul Mehta",
    );
    expect(container.textContent).not.toContain("Done");
    expect(container.textContent).not.toMatch(/grant_SECRET|usr_SECRET/);
    unmount();

    const sent = {
      status: "sos_sent",
      spoken_facts: ["Your position reached Priya Nair and Rahul Mehta."],
      delivered: ["Priya Nair", "Rahul Mehta"],
      not_alerted: [],
      alert_active: true,
    };
    const fullySent = replay(
      [
        {
          type: "pending_action.resolved",
          pending_action_id: "pa_SECRET_sos",
          status: "executed",
          result_public: sent,
        },
        {
          type: "tool.result",
          call_id: null,
          tool: "report_save_my_soul_delivery",
          status: "sos_sent",
          ok: true,
          result_public: { ...sent },
        },
      ],
      reduceVoiceSession(base, { type: "client_step_done", stepId: "step_SECRET" }),
    );
    render(<OneVoicePanel state={fullySent} controller={controller()} />);
    expect(screen.getByTestId("one-voice-pending-resolved")).toHaveTextContent(
      "Sent",
    );
    expect(screen.getAllByTestId("one-voice-tool-result")).toHaveLength(1);
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Sent");
    expect(screen.getByTestId("one-voice-tool-result")).toHaveAttribute(
      "data-tone",
      "success",
    );

    const notSent = { status: "sos_not_sent", not_alerted: ["Priya Nair", "Rahul Mehta"], alert_active: true };
    const failed = replay(
      [
        {
          type: "pending_action.resolved",
          pending_action_id: "pa_SECRET_sos",
          status: "failed",
          result_public: notSent,
        },
        {
          type: "tool.result",
          call_id: null,
          tool: "report_save_my_soul_delivery",
          status: "sos_not_sent",
          ok: false,
          result_public: { ...notSent },
        },
      ],
      reduceVoiceSession(base, { type: "client_step_done", stepId: "step_SECRET" }),
    );
    cleanup();
    render(<OneVoicePanel state={failed} controller={controller()} />);
    expect(screen.getByTestId("one-voice-pending-resolved")).toHaveTextContent(
      "Not sent",
    );
    expect(screen.getAllByTestId("one-voice-tool-result")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Not sent");
    expect(screen.queryByText("Done")).toBeNull();
  });
});
