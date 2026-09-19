import { describe, expect, it } from "vitest";

import { resolveOnboardingProgress } from "@/lib/onboarding/onboarding-progress";
import { ONE_SETUP_CAPABILITIES } from "@/lib/onboarding/one-capabilities";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";

function status(state: CapabilityStatus["state"]): CapabilityStatus {
  return {
    id: "x",
    state,
    pendingCount: 0,
    prerequisite: null,
    requiresUnlock: false,
  };
}

const ALL_IDS = ONE_SETUP_CAPABILITIES.map((c) => c.id);

describe("resolveOnboardingProgress", () => {
  it("counts nothing done and nothing dismissed as 0 of N", () => {
    const progress = resolveOnboardingProgress({}, new Set());
    expect(progress.completed).toBe(0);
    expect(progress.total).toBe(ALL_IDS.length);
    expect(progress.isFinished).toBe(false);
  });

  it("a completed capability increases the numerator only", () => {
    const [first] = ALL_IDS;
    const progress = resolveOnboardingProgress(
      { [first]: status("completed") },
      new Set(),
    );
    expect(progress.completed).toBe(1);
    expect(progress.total).toBe(ALL_IDS.length);
    expect(progress.completedIds).toContain(first);
  });

  it("a permanently declined (skipped) capability drops out of the denominator", () => {
    const [first] = ALL_IDS;
    const progress = resolveOnboardingProgress(
      { [first]: status("skipped") },
      new Set(),
    );
    expect(progress.total).toBe(ALL_IDS.length - 1);
    expect(progress.dismissedIds).toContain(first);
    expect(progress.remainingIds).not.toContain(first);
  });

  it("a session-soft-dismissed capability also drops out of the denominator", () => {
    const [first] = ALL_IDS;
    const progress = resolveOnboardingProgress({}, new Set([first]));
    expect(progress.total).toBe(ALL_IDS.length - 1);
    expect(progress.dismissedIds).toContain(first);
  });

  it("is finished once every capability is completed or dismissed", () => {
    const statusById: Record<string, CapabilityStatus> = {};
    const dismissed = new Set<string>();
    ALL_IDS.forEach((id, index) => {
      if (index % 2 === 0) statusById[id] = status("completed");
      else dismissed.add(id);
    });
    const progress = resolveOnboardingProgress(statusById, dismissed);
    expect(progress.remainingIds).toHaveLength(0);
    expect(progress.isFinished).toBe(true);
  });

  it("is not finished while at least one capability is still undecided", () => {
    const [first] = ALL_IDS;
    const progress = resolveOnboardingProgress(
      { [first]: status("not-started") },
      new Set(),
    );
    expect(progress.isFinished).toBe(false);
    expect(progress.remainingIds).toContain(first);
  });
});
