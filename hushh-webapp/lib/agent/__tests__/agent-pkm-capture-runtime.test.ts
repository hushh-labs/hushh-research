import { beforeEach, describe, expect, it } from "vitest";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import {
  aggregateAgentPkmCaptures,
  createAgentPkmCaptureGuard,
  describeAgentPkmCapture,
  shouldPublishAgentPkmCapture,
} from "../agent-pkm-capture-runtime";

describe("Memory capture session boundary", () => {
  it("retains every invocation receipt regardless of completion order", () => {
    const receipts = [
      { phase: "saved" as const, saved: 2 },
      { phase: "failed" as const, saved: 0 },
    ];
    expect(aggregateAgentPkmCaptures(receipts)).toEqual({
      phase: "partial",
      saved: 2,
    });
    expect(aggregateAgentPkmCaptures([...receipts].reverse())).toEqual({
      phase: "partial",
      saved: 2,
    });
    expect(
      aggregateAgentPkmCaptures([...receipts, { phase: "saving", saved: 0 }]),
    ).toEqual({ phase: "saving", saved: 2 });
    expect(
      aggregateAgentPkmCaptures([
        { phase: "saved", saved: 2 },
        { phase: "saved", saved: 3 },
      ]),
    ).toEqual({ phase: "saved", saved: 5 });
  });
  beforeEach(() => publishValidatedAuthSessionOwner("owner-a"));
  const create = (isEnabled = () => true) => {
    const controller = new AbortController();
    return {
      controller,
      ...createAgentPkmCaptureGuard({
        userId: "owner-a",
        signal: controller.signal,
        isEnabled,
      }),
    };
  };
  it("rejects lock or token replacement before a later effect", async () => {
    const guard = create();
    await guard.assertCurrent();
    advanceVaultSessionEpoch();
    await expect(guard.assertCurrent()).rejects.toMatchObject({
      name: "AbortError",
    });
  });
  it("rejects owner switch and switch back", async () => {
    const guard = create();
    publishValidatedAuthSessionOwner("owner-b");
    publishValidatedAuthSessionOwner("owner-a");
    await expect(guard.assertCurrent()).rejects.toMatchObject({
      name: "AbortError",
    });
  });
  it("rejects conversation cancellation but not a later turn in the same session", async () => {
    const earlierTurn = create();
    const laterTurn = create();
    await earlierTurn.assertCurrent();
    await laterTurn.assertCurrent();
    earlierTurn.controller.abort();
    expect(earlierTurn.isCurrent()).toBe(false);
    expect(laterTurn.isCurrent()).toBe(true);
  });
  it("fails closed for disabled policy or mismatched caller", async () => {
    let enabled = true;
    const guard = create(() => enabled);
    enabled = false;
    expect(guard.isCurrent()).toBe(false);
    const wrong = createAgentPkmCaptureGuard({
      userId: "other",
      signal: new AbortController().signal,
      isEnabled: () => true,
    });
    expect(wrong.isCurrent()).toBe(false);
  });
  it("distinguishes preparation, saved receipts, and partial results without personal details", () => {
    expect(
      describeAgentPkmCapture({ phase: "preparing", saved: 0 }),
    ).not.toContain("saved");
    expect(describeAgentPkmCapture({ phase: "saved", saved: 2 })).toBe(
      "2 details saved privately",
    );
    expect(describeAgentPkmCapture({ phase: "partial", saved: 1 })).toContain(
      "some details still need attention",
    );
  });
  it("always resolves the status line: a terminal status publishes even after the session lapsed", () => {
    // 2026-09-29: the vault token expired by the clock mid-capture, the guard
    // turned false, the final status was dropped, and "Checking for details
    // worth remembering…" stayed on screen for good.
    expect(shouldPublishAgentPkmCapture({ phase: "failed", saved: 0 }, false)).toBe(true);
    expect(shouldPublishAgentPkmCapture({ phase: "canceled", saved: 0 }, false)).toBe(true);
    expect(shouldPublishAgentPkmCapture({ phase: "saved", saved: 3 }, false)).toBe(true);
    expect(shouldPublishAgentPkmCapture({ phase: "preparing", saved: 0 }, false)).toBe(false);
    expect(shouldPublishAgentPkmCapture({ phase: "preparing", saved: 0 }, true)).toBe(true);
    expect(describeAgentPkmCapture({ phase: "failed", saved: 0, reason: "timeout" }))
      .toBe("Memory capture timed out. Nothing was saved.");
    expect(describeAgentPkmCapture({ phase: "needs_unlock", saved: 0 }))
      .toBe("Unlock your vault to save this. Nothing was saved.");
    expect(describeAgentPkmCapture({ phase: "preparing", saved: 0, progress: { stage: "reading", done: 3, total: 12 } }))
      .toBe("Reading section 3 of 12…");
  });
});
