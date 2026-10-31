import { describe, expect, it } from "vitest";

import {
  getCapabilityStatusDisplay,
  isCapabilityOnboarded,
} from "@/lib/onboarding/capability-status-display";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";

function status(overrides: Partial<CapabilityStatus>): CapabilityStatus {
  return {
    id: "x",
    state: "not-started",
    pendingCount: 0,
    prerequisite: null,
    requiresUnlock: false,
    ...overrides,
  };
}

describe("getCapabilityStatusDisplay — location", () => {
  it("shows 'Set up location' when not-started", () => {
    expect(
      getCapabilityStatusDisplay(status({ id: "location", state: "not-started" })).label,
    ).toBe("Set up location");
  });

  it("shows 'Ready' when completed", () => {
    expect(
      getCapabilityStatusDisplay(status({ id: "location", state: "completed" })).label,
    ).toBe("Ready");
  });

  it("keeps a vault-gated setup actionable without exposing the prerequisite", () => {
    expect(
      getCapabilityStatusDisplay(
        status({ id: "location", state: "unknown", requiresUnlock: true }),
    ).label,
    ).toBe("Set up");
  });

  it("other capabilities keep the generic 'Set up'", () => {
    expect(
      getCapabilityStatusDisplay(status({ id: "email", state: "not-started" })).label,
    ).toBe("Set up");
  });
});

describe("isCapabilityOnboarded", () => {
  it("is true only when genuinely completed", () => {
    expect(isCapabilityOnboarded(status({ state: "completed" }))).toBe(true);
  });

  it("is false for every other tracked state, including skipped/dismissed", () => {
    for (const state of [
      "unknown",
      "blocked",
      "not-started",
      "in-progress",
      "skipped",
      "needs-attention",
    ] as const) {
      expect(isCapabilityOnboarded(status({ state }))).toBe(false);
    }
  });

  it("treats an untracked capability (no resolvable status) as onboarded", () => {
    expect(isCapabilityOnboarded(undefined)).toBe(true);
  });
});
