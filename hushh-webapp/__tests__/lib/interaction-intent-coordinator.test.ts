import { describe, expect, it, vi } from "vitest";

import { InteractionIntentCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

describe("InteractionIntentCoordinator", () => {
  it("retains the route key and contextual mode for immediate tab selection", () => {
    const coordinator = new InteractionIntentCoordinator();
    const cancel = vi.fn();

    const intent = coordinator.requestNavigation({
      target: "/one/kai?tab=portfolio",
      source: "tap",
      transitionMode: "contextual",
      start: () => cancel,
    });

    expect(intent).toMatchObject({
      target: "/one/kai?tab=portfolio",
      transitionMode: "contextual",
      status: "accepted",
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("keeps only the latest pending navigation and preserves a same-target intent", () => {
    const coordinator = new InteractionIntentCoordinator();
    const cancelA = vi.fn();
    const cancelB = vi.fn();
    const start = vi.fn();

    const first = coordinator.requestNavigation({
      target: "/one",
      source: "tap",
      start: () => {
        start("one");
        return cancelA;
      },
    });
    const duplicate = coordinator.requestNavigation({
      target: "/one",
      source: "tap",
      start: () => {
        start("duplicate");
        return vi.fn();
      },
    });
    const newest = coordinator.requestNavigation({
      target: "/one/kai",
      source: "tap",
      start: () => {
        start("kai");
        return cancelB;
      },
    });

    expect(duplicate.id).toBe(first.id);
    expect(start).toHaveBeenCalledTimes(2);
    expect(cancelA).toHaveBeenCalledWith("superseded_by_newer_navigation");
    expect(coordinator.isCurrentNavigation(first.id)).toBe(false);
    expect(coordinator.isCurrentNavigation(newest.id)).toBe(true);

    coordinator.settleNavigation(newest.id, "pathname_settled");
    expect(coordinator.getSnapshot().find((intent) => intent.id === first.id)?.status).toBe(
      "superseded",
    );
    expect(coordinator.getSnapshot().find((intent) => intent.id === newest.id)?.status).toBe(
      "settled",
    );
  });

  it("provides one current voice lease and a bounded exact-once directive ledger", () => {
    const coordinator = new InteractionIntentCoordinator();
    const revokeFirst = vi.fn();
    const first = coordinator.acquireVoiceLease({
      owner: "one_live",
      onRevoked: revokeFirst,
    });
    const second = coordinator.acquireVoiceLease({
      owner: "one_chat",
      onRevoked: vi.fn(),
    });

    expect(revokeFirst).toHaveBeenCalledWith("superseded_by_newer_voice_session");
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);

    expect(
      coordinator.beginDirective({
        sessionId: second.id,
        directiveId: "directive_1",
        fingerprint: "safe-digest",
      }),
    ).toEqual({ state: "new" });
    expect(
      coordinator.beginDirective({
        sessionId: second.id,
        directiveId: "directive_1",
        fingerprint: "safe-digest",
      }),
    ).toEqual({ state: "duplicate", settlement: null });
    expect(
      coordinator.beginDirective({
        sessionId: second.id,
        directiveId: "directive_1",
        fingerprint: "different-digest",
      }),
    ).toEqual({ state: "conflict" });
  });

  it("publishes truthful action progress and replays only the first terminal directive outcome", () => {
    const coordinator = new InteractionIntentCoordinator();
    const run = coordinator.startActionRun({
      actionId: "route.kai_analysis",
      label: "Analysis",
      source: "voice",
      directiveId: "directive_1",
    });

    expect(coordinator.getActiveActionRun()).toMatchObject({
      id: run.id,
      phase: "acknowledged",
      message: "Preparing Analysis",
    });

    coordinator.updateActionRun(run.id, { phase: "navigating" });
    expect(coordinator.getActiveActionRun()).toMatchObject({
      phase: "navigating",
      message: "Opening Analysis",
    });

    expect(
      coordinator.beginDirective({
        sessionId: "voice_1",
        directiveId: "directive_1",
        fingerprint: "safe-digest",
      }),
    ).toEqual({ state: "new" });
    coordinator.settleDirective("voice_1", "directive_1", {
      status: "succeeded",
      summary: "Analysis is ready.",
    });
    coordinator.finishActionRunFromSettlement(run.id, {
      status: "succeeded",
      summary: "Analysis is ready.",
    });

    expect(coordinator.getActiveActionRun()).toBeNull();
    expect(
      coordinator.beginDirective({
        sessionId: "voice_1",
        directiveId: "directive_1",
        fingerprint: "safe-digest",
      }),
    ).toEqual({
      state: "duplicate",
      settlement: { status: "succeeded", summary: "Analysis is ready." },
    });
  });

  it("patches subject without moving phase, and later phase-only updates keep it", () => {
    const coordinator = new InteractionIntentCoordinator();
    const run = coordinator.startActionRun({
      actionId: "connect.send_request",
      label: "Send a connection request",
      source: "voice",
    });
    expect(coordinator.getActiveActionRun()).toMatchObject({ subject: null });

    coordinator.updateActionRun(run.id, {
      subject: { name: "Ankit Kumar Singh", detail: "an•••@hushh.ai" },
    });
    expect(coordinator.getActiveActionRun()).toMatchObject({
      phase: "acknowledged",
      subject: { name: "Ankit Kumar Singh", detail: "an•••@hushh.ai" },
    });

    coordinator.finishActionRunFromSettlement(run.id, {
      status: "succeeded",
      summary: "Connection request sent to Ankit Kumar Singh.",
    });
    const snapshot = coordinator
      .getActionRunsSnapshot()
      .find((entry) => entry.id === run.id);
    expect(snapshot).toMatchObject({
      phase: "completed",
      subject: { name: "Ankit Kumar Singh", detail: "an•••@hushh.ai" },
    });
  });

  it("carries an optional goalId through a run so related steps can be grouped later", () => {
    const coordinator = new InteractionIntentCoordinator();
    const withGoal = coordinator.startActionRun({
      actionId: "location.pause_updates",
      label: "Pause updates",
      source: "voice",
      directiveId: "directive_1",
      goalId: "goal.location.pause_updates",
    });
    const withoutGoal = coordinator.startActionRun({
      actionId: "connect.open_people",
      label: "Open Connect people",
      source: "voice",
      directiveId: "directive_2",
    });

    expect(withGoal.goalId).toBe("goal.location.pause_updates");
    expect(withoutGoal.goalId).toBeNull();
  });

  it("renders a backend-direct action_result directive as an already-terminal run", () => {
    // Mirrors exactly what agent-bar.tsx's `kind === "action_result"` branch
    // does: no directiveId (nothing to settle), start then immediately move
    // to the terminal phase the backend already computed.
    const coordinator = new InteractionIntentCoordinator();
    const run = coordinator.startActionRun({
      actionId: "connect.remove_connection",
      label: "Remove connection",
      source: "voice",
      message: "Removed Roopmann. They can no longer be picked for location sharing.",
    });
    expect(run.directiveId).toBeNull();
    expect(run.phase).toBe("acknowledged");

    const updated = coordinator.updateActionRun(run.id, {
      phase: "completed",
      message: "Removed Roopmann. They can no longer be picked for location sharing.",
    });

    expect(updated).toMatchObject({
      id: run.id,
      phase: "completed",
      message: "Removed Roopmann. They can no longer be picked for location sharing.",
    });
    expect(updated?.completedAtMs).not.toBeNull();
    // No active run left to show a spinner for -- it settled immediately,
    // same as any other terminal run.
    expect(coordinator.getActiveActionRun()).toBeNull();
    // But it stays in the rolling snapshot VoiceWalkthroughPanel reads, so
    // the person still sees what happened, not a card that vanished.
    expect(coordinator.getActionRunsSnapshot()).toContainEqual(
      expect.objectContaining({ id: run.id, phase: "completed" }),
    );
  });

  it("renders a failed action_result the same way, with the failure message visible", () => {
    const coordinator = new InteractionIntentCoordinator();
    const run = coordinator.startActionRun({
      actionId: "location.approve_request",
      label: "Approve request",
      source: "voice",
      message: "That request is no longer pending.",
    });

    const updated = coordinator.updateActionRun(run.id, {
      phase: "failed",
      message: "That request is no longer pending.",
    });

    expect(updated?.phase).toBe("failed");
    expect(updated?.message).toBe("That request is no longer pending.");
  });

  it("cancels non-terminal interaction work on background without owning vault state", () => {
    const coordinator = new InteractionIntentCoordinator();
    const cancelNavigation = vi.fn();
    const stopVoice = vi.fn();
    const navigation = coordinator.requestNavigation({
      target: "/one/kai",
      source: "tap",
      start: () => cancelNavigation,
    });
    const voice = coordinator.acquireVoiceLease({
      owner: "one_live",
      onRevoked: stopVoice,
    });
    const actionRun = coordinator.startActionRun({
      actionId: "analysis.start",
      label: "Analysis",
      source: "voice",
    });

    coordinator.handleLifecycle("background");

    expect(cancelNavigation).toHaveBeenCalledWith("app_backgrounded");
    expect(stopVoice).toHaveBeenCalledWith("app_backgrounded");
    expect(voice.isCurrent()).toBe(false);
    expect(coordinator.getSnapshot().find((intent) => intent.id === navigation.id)?.status).toBe(
      "cancelled",
    );
    expect(
      coordinator
        .getActionRunsSnapshot()
        .find((run) => run.id === actionRun.id),
    ).toMatchObject({
      phase: "cancelled",
      message: "Action cancelled because the app was backgrounded",
    });
  });

  it("publishes one ordered lifecycle stream and ignores duplicate native/browser events", () => {
    const coordinator = new InteractionIntentCoordinator();
    const revisions: Array<{ state: string; revision: number }> = [];
    const unsubscribe = coordinator.subscribeLifecycle(() => {
      const snapshot = coordinator.getLifecycleSnapshot();
      revisions.push({ state: snapshot.state, revision: snapshot.revision });
    });

    coordinator.handleLifecycle("background");
    coordinator.handleLifecycle("background");
    coordinator.handleLifecycle("active");

    expect(revisions).toEqual([
      { state: "background", revision: 1 },
      { state: "active", revision: 2 },
    ]);
    expect(coordinator.getLifecycleSnapshot()).toMatchObject({
      state: "active",
      revision: 2,
    });

    unsubscribe();
  });
});
