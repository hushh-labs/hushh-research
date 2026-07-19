import { describe, expect, it, vi } from "vitest";

import { InteractionIntentCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

describe("InteractionIntentCoordinator", () => {
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
    ).toEqual({ state: "duplicate" });
    expect(
      coordinator.beginDirective({
        sessionId: second.id,
        directiveId: "directive_1",
        fingerprint: "different-digest",
      }),
    ).toEqual({ state: "conflict" });
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

    coordinator.handleLifecycle("background");

    expect(cancelNavigation).toHaveBeenCalledWith("app_backgrounded");
    expect(stopVoice).toHaveBeenCalledWith("app_backgrounded");
    expect(voice.isCurrent()).toBe(false);
    expect(coordinator.getSnapshot().find((intent) => intent.id === navigation.id)?.status).toBe(
      "cancelled",
    );
  });
});
