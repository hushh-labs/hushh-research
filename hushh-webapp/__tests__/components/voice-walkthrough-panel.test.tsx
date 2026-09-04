import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  collapseRepeatedSteps,
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

describe("collapseRepeatedSteps", () => {
  it("keeps a single step untouched", () => {
    const steps = [run({ id: "a" })];
    expect(collapseRepeatedSteps(steps).map((s) => s.id)).toEqual(["a"]);
  });

  it("collapses two runs that would render the identical sentence", () => {
    // The reported bug: asking twice for something that refuses drew the same
    // refusal twice, reading as two separate failures.
    const steps = [
      run({
        id: "first",
        actionId: "location.trigger_sos",
        phase: "blocked",
        message: "Add at least one emergency contact before sending an SOS.",
      }),
      run({
        id: "second",
        actionId: "location.trigger_sos",
        phase: "blocked",
        message: "Add at least one emergency contact before sending an SOS.",
      }),
    ];
    expect(collapseRepeatedSteps(steps).map((s) => s.id)).toEqual(["second"]);
  });

  it("keeps the newest of a repeat, so a retry that succeeds is what shows", () => {
    const steps = [
      run({ id: "failed", actionId: "location.refresh", phase: "failed", message: "Same text" }),
      run({ id: "ok", actionId: "location.refresh", phase: "completed", message: "Same text" }),
    ];
    const kept = collapseRepeatedSteps(steps);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.phase).toBe("completed");
  });

  it("keeps the same action over different subjects -- those are real separate steps", () => {
    // Guards the obvious over-collapse: deduping on actionId alone would hide
    // one of these, and "add Alex and Sam" would silently look like one add.
    const steps = [
      run({
        id: "alex",
        actionId: "location.add_to_circle",
        message: "Added to Family.",
        subject: { name: "Alex" },
      }),
      run({
        id: "sam",
        actionId: "location.add_to_circle",
        message: "Added to Family.",
        subject: { name: "Sam" },
      }),
    ];
    expect(collapseRepeatedSteps(steps).map((s) => s.id)).toEqual(["alex", "sam"]);
  });

  it("keeps genuinely different steps of one task", () => {
    const steps = [
      run({ id: "nav", actionId: "location.open_now", message: "Opening Location" }),
      run({ id: "act", actionId: "location.share_selected", message: "Sharing" }),
    ];
    expect(collapseRepeatedSteps(steps).map((s) => s.id)).toEqual(["nav", "act"]);
  });
});

describe("VoiceWalkthroughPanel", () => {
  beforeEach(() => {
    appInteractionCoordinator.resetActionRunsForTests();
  });

  it("shows only the latest step when walk-through mode is off, even with a running multi-step task", () => {
    // Walk-through mode gates GROUPING multiple steps into one panel, not
    // whether a card shows at all -- every action still earns its own card.
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

    expect(screen.getByTestId("voice-walkthrough-panel")).toBeInTheDocument();
    expect(screen.getByText("Preparing Pick recipient")).toBeInTheDocument();
    expect(screen.queryByText("Preparing Open Location")).toBeNull();
  });

  it("shows a card for a single-step task with no subject, using its own message", () => {
    appInteractionCoordinator.startActionRun({
      actionId: "location.pause_updates",
      label: "Pause updates",
      source: "voice",
    });

    render(<VoiceWalkthroughPanel enabled />);

    expect(screen.getByTestId("voice-walkthrough-panel")).toBeInTheDocument();
    expect(screen.getByText("Preparing Pause updates")).toBeInTheDocument();
  });

  it("shows a single-step task's subject even when walk-through mode is off", () => {
    const solo = appInteractionCoordinator.startActionRun({
      actionId: "location.share_selected",
      label: "Share location",
      source: "voice",
    });
    appInteractionCoordinator.updateActionRun(solo.id, {
      phase: "completed",
      message: "Shared your location with Sarah Chen.",
      subject: { name: "Sarah Chen" },
    });

    render(<VoiceWalkthroughPanel enabled={false} />);

    expect(screen.getByTestId("voice-walkthrough-panel")).toBeInTheDocument();
    expect(screen.getByText("Shared your location with Sarah Chen.")).toBeInTheDocument();
    expect(screen.getByText("Sarah Chen")).toBeInTheDocument();
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
    expect(screen.getByText("Preparing Send a connection request")).toBeInTheDocument();
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

  it("shows a repeated refusal once, not stacked", () => {
    // Two attempts at the same blocked action, close enough together that
    // currentTaskSteps groups them. The card must not read as two failures.
    const first = appInteractionCoordinator.startActionRun({
      actionId: "location.trigger_sos",
      label: "Send an SOS",
      source: "voice",
    });
    appInteractionCoordinator.finishActionRunFromSettlement(first.id, {
      status: "blocked",
      summary: "Add at least one emergency contact before sending an SOS.",
    });
    const second = appInteractionCoordinator.startActionRun({
      actionId: "location.trigger_sos",
      label: "Send an SOS",
      source: "voice",
    });
    appInteractionCoordinator.finishActionRunFromSettlement(second.id, {
      status: "blocked",
      summary: "Add at least one emergency contact before sending an SOS.",
    });

    render(<VoiceWalkthroughPanel enabled />);

    expect(
      screen.getAllByText("Add at least one emergency contact before sending an SOS."),
    ).toHaveLength(1);
  });

  it("does not truncate a long message -- the whole line stays readable", () => {
    // The instruction the person has to act on lives in this sentence; an
    // ellipsis in the middle of it hides the actionable half.
    const long =
      "Add at least one emergency contact before sending an SOS, then try again.";
    const solo = appInteractionCoordinator.startActionRun({
      actionId: "location.trigger_sos",
      label: "Send an SOS",
      source: "voice",
    });
    appInteractionCoordinator.finishActionRunFromSettlement(solo.id, {
      status: "blocked",
      summary: long,
    });

    render(<VoiceWalkthroughPanel enabled />);

    const line = screen.getByText(long);
    // `truncate` is what clipped it: overflow-hidden + nowrap + ellipsis.
    // Asserting on the class is what actually pins the regression, since
    // jsdom has no layout to measure a visual clip with.
    expect(line.className).not.toContain("truncate");
    expect(line.className).toContain("break-words");
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
    expect(screen.getByText("Preparing Open Location")).toBeInTheDocument();
    expect(screen.getByText("Preparing Pick recipient")).toBeInTheDocument();
  });
});
