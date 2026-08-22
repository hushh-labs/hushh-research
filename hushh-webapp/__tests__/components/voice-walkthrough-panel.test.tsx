import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  currentTaskSteps,
  VoiceWalkthroughPanel,
} from "@/components/agent/voice-walkthrough-panel";
import {
  appInteractionCoordinator,
  type ActionRun,
} from "@/lib/interaction/interaction-intent-coordinator";

function run(overrides: Partial<ActionRun> & { id: string }): ActionRun {
  return {
    id: overrides.id,
    actionId: overrides.actionId ?? "location.pause_updates",
    label: overrides.label ?? "Pause updates",
    source: overrides.source ?? "voice",
    directiveId: overrides.directiveId ?? null,
    goalId: overrides.goalId ?? null,
    phase: overrides.phase ?? "executing",
    message: overrides.message ?? "Working",
    subject: overrides.subject ?? null,
    createdAtMs: overrides.createdAtMs ?? 0,
    updatedAtMs: overrides.updatedAtMs ?? overrides.createdAtMs ?? 0,
    completedAtMs: overrides.completedAtMs ?? null,
  };
}

describe("currentTaskSteps", () => {
  it("returns nothing for an empty history", () => {
    expect(currentTaskSteps([])).toEqual([]);
  });

  it("groups steps sharing a goalId regardless of the time between them", () => {
    const runs = [
      run({ id: "a", goalId: "goal.x", createdAtMs: 0, updatedAtMs: 0 }),
      run({ id: "b", goalId: "goal.x", createdAtMs: 60_000, updatedAtMs: 60_000 }),
    ];
    expect(currentTaskSteps(runs).map((step) => step.id)).toEqual(["a", "b"]);
  });

  it("groups goalId-less steps that arrive within the gap window", () => {
    const runs = [
      run({ id: "a", createdAtMs: 0, updatedAtMs: 1_000 }),
      run({ id: "b", createdAtMs: 5_000, updatedAtMs: 5_000 }),
    ];
    expect(currentTaskSteps(runs).map((step) => step.id)).toEqual(["a", "b"]);
  });

  it("stops at a step that shares no goalId and arrived after the gap window", () => {
    const runs = [
      run({ id: "old", createdAtMs: 0, updatedAtMs: 0 }),
      run({ id: "new", createdAtMs: 20_000, updatedAtMs: 20_000 }),
    ];
    expect(currentTaskSteps(runs).map((step) => step.id)).toEqual(["new"]);
  });

  it("walks past an unrelated older run once it reaches a run outside the gap", () => {
    const runs = [
      run({ id: "unrelated", createdAtMs: 0, updatedAtMs: 0 }),
      run({ id: "b", goalId: "goal.x", createdAtMs: 30_000, updatedAtMs: 30_000 }),
      run({ id: "c", goalId: "goal.x", createdAtMs: 30_500, updatedAtMs: 30_500 }),
    ];
    expect(currentTaskSteps(runs).map((step) => step.id)).toEqual(["b", "c"]);
  });
});

describe("VoiceWalkthroughPanel", () => {
  beforeEach(() => {
    appInteractionCoordinator.resetActionRunsForTests();
  });

  it("renders nothing when walk-through mode is off, even with a running multi-step task", () => {
    const first = appInteractionCoordinator.startActionRun({
      actionId: "location.open_now",
      label: "Open Location",
      source: "voice",
      goalId: "goal.share",
    });
    appInteractionCoordinator.startActionRun({
      actionId: "location.select_share_recipient",
      label: "Pick recipient",
      source: "voice",
      directiveId: first.directiveId ?? "d2",
      goalId: "goal.share",
    });

    render(<VoiceWalkthroughPanel enabled={false} />);

    expect(screen.queryByTestId("voice-walkthrough-panel")).toBeNull();
  });

  it("stays hidden for a single-step task, since the bar already shows its status", () => {
    appInteractionCoordinator.startActionRun({
      actionId: "location.pause_updates",
      label: "Pause updates",
      source: "voice",
    });

    render(<VoiceWalkthroughPanel enabled />);

    expect(screen.queryByTestId("voice-walkthrough-panel")).toBeNull();
  });

  it("shows a single-step task once a handler names who it's about", () => {
    const solo = appInteractionCoordinator.startActionRun({
      actionId: "connect.send_request",
      label: "Send a connection request",
      source: "voice",
    });
    appInteractionCoordinator.updateActionRun(solo.id, {
      subject: { name: "Ankit Kumar Singh", detail: "an•••@hushh.ai" },
    });

    render(<VoiceWalkthroughPanel enabled />);

    expect(screen.getByTestId("voice-walkthrough-panel")).toBeInTheDocument();
    expect(screen.getByText("Ankit Kumar Singh")).toBeInTheDocument();
    expect(screen.getByText("an•••@hushh.ai")).toBeInTheDocument();
  });

  it("shows a subject-capable single-step task while it is still processing, before any subject is known", () => {
    // The whole point: "send it" is a lone run for connect.send_request, and
    // the subject is not known until the handler returns. If the panel
    // waited for a subject before showing, it would never appear during the
    // actual processing -- only in the instant before it disappears.
    appInteractionCoordinator.startActionRun({
      actionId: "connect.send_request",
      label: "Send a connection request",
      source: "voice",
      phase: "preparing",
    });

    render(<VoiceWalkthroughPanel enabled />);

    expect(screen.getByTestId("voice-walkthrough-panel")).toBeInTheDocument();
    expect(screen.getByText("Send a connection request")).toBeInTheDocument();
  });

  it("closing an active task aborts it and hides the card without it reappearing", () => {
    vi.useFakeTimers();
    try {
      appInteractionCoordinator.startActionRun({
        actionId: "connect.send_request",
        label: "Send a connection request",
        source: "voice",
      });
      const onCancel = vi.fn();

      render(<VoiceWalkthroughPanel enabled onCancel={onCancel} />);
      expect(screen.getByTestId("voice-walkthrough-panel")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Stop this task" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("voice-walkthrough-panel")).toBeNull();

      // The linger effect re-syncs after a phase change. A run this test
      // never marks cancelled/terminal still must not resurrect the card the
      // close button just hid.
      vi.advanceTimersByTime(10_000);
      expect(screen.queryByTestId("voice-walkthrough-panel")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closing a settled task just dismisses it, without calling onCancel", () => {
    const solo = appInteractionCoordinator.startActionRun({
      actionId: "connect.send_request",
      label: "Send a connection request",
      source: "voice",
    });
    appInteractionCoordinator.finishActionRunFromSettlement(solo.id, {
      status: "succeeded",
      summary: "Connection request sent to Ankit Kumar Singh.",
    });
    const onCancel = vi.fn();

    render(<VoiceWalkthroughPanel enabled onCancel={onCancel} />);
    expect(screen.getByTestId("voice-walkthrough-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByTestId("voice-walkthrough-panel")).toBeNull();
  });

  it("shows a live step list for a multi-step task when enabled", () => {
    appInteractionCoordinator.startActionRun({
      actionId: "location.open_now",
      label: "Open Location",
      source: "voice",
      directiveId: "d1",
      goalId: "goal.share",
    });
    appInteractionCoordinator.startActionRun({
      actionId: "location.select_share_recipient",
      label: "Pick recipient",
      source: "voice",
      directiveId: "d2",
      goalId: "goal.share",
    });

    render(<VoiceWalkthroughPanel enabled />);

    expect(screen.getByTestId("voice-walkthrough-panel")).toBeInTheDocument();
    expect(screen.getByText("Open Location")).toBeInTheDocument();
    expect(screen.getByText("Pick recipient")).toBeInTheDocument();
  });
});
